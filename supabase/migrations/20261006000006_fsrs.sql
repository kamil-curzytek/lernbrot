-- FSRS memory model (research/review-strategy/review-strategy.md).
-- 1. Each word's progress stores an FSRS memory state: stability (days until predicted recall falls
--    to 90 %), fsrs_difficulty (1..10) and the time of the last scored review. The browser computes
--    the next state with ts-fsrs (FSRS-6 default parameters) and submit_quiz validates and stores it.
-- 2. Review gaps keep growing (max 5 years) instead of stopping at 60 days.
-- 3. Due reviews are ordered by predicted recall: the word most likely forgotten comes first.
-- streak / status / difficulty are kept: the quiz uses streak for question difficulty, the UI shows status.
-- submit_quiz p_schedule entries now also carry stability and fsrs_difficulty.

alter table public.vocabulary_progress
  add column if not exists stability       double precision check (stability > 0),
  add column if not exists fsrs_difficulty double precision check (fsrs_difficulty between 1 and 10),
  add column if not exists last_review_at  timestamptz;

-- Existing rows: start from the old schedule. The old interval becomes the stability (recall ~90 % when
-- due), old difficulty 0..10 maps to 3..10. Safe to re-run: only rows without a state are touched.
update public.vocabulary_progress
   set stability = greatest(1, round(extract(epoch from (next_review_at - last_seen_at)) / 86400)),
       fsrs_difficulty = least(10, 3 + 0.7 * difficulty),
       last_review_at = last_seen_at
 where stability is null and last_seen_at is not null and next_review_at is not null;

-- Predicted recall probability (FSRS-6 forgetting curve, default decay 0.1542). Unknown state = 0,
-- so such words sort first.
create or replace function public.fsrs_retrievability(p_stability double precision, p_last_review timestamptz, p_at timestamptz)
returns double precision
language sql immutable as $$
  select case
           when p_stability is null or p_last_review is null then 0
           else power(1 + (power(0.9, -1 / 0.1542) - 1)
                          * greatest(0, extract(epoch from (p_at - p_last_review)) / 86400) / p_stability,
                      -0.1542)
         end
$$;

create or replace function public.create_daily_session_for(p_user_id uuid, p_session_date date)
returns public.daily_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_profile    public.profiles;
  v_session    public.daily_sessions;
  v_target     int;
  v_min_new    int;
  v_day_start  timestamptz;
  v_day_end    timestamptz;
  v_user_rank  int;
  v_new_avail  int;
  v_due_count  int;
  v_review_cap int;
  v_due        int[];
  v_struggling int[];
  v_reviews    int[];
  v_new        int[];
  v_fill       int[];
begin
  select * into v_session from daily_sessions
   where user_id = p_user_id and session_date = p_session_date;
  if found then
    return v_session;
  end if;

  select * into v_profile from profiles where id = p_user_id;
  if not found then
    raise exception 'profile % not found', p_user_id;
  end if;

  v_target    := v_profile.daily_word_target;
  v_day_start := p_session_date::timestamp at time zone v_profile.timezone;
  v_day_end   := (p_session_date + 1)::timestamp at time zone v_profile.timezone;
  v_user_rank := cefr_rank(v_profile.current_cefr_level);

  -- How many new words to keep, depending on the review backlog:
  --   up to the target due      -> at least 20% new (10 -> 2)
  --   1x..2x the target due     -> at least 10% new (10 -> 1)
  --   2x the target or more due -> catch-up day, no new words until the backlog shrinks
  -- Forcing new words in while reviews pile up makes the backlog grow without limit.
  select count(*) into v_due_count
    from vocabulary_progress p
   where p.user_id = p_user_id and p.next_review_at < v_day_end;
  v_min_new := case
                 when v_due_count <= v_target    then ceil(v_target * 0.2)::int
                 when v_due_count < 2 * v_target then ceil(v_target * 0.1)::int
                 else 0
               end;

  select count(*) into v_new_avail
    from vocabulary_words w
   where not exists (select 1 from vocabulary_progress p
                      where p.user_id = p_user_id and p.word_id = w.id);

  v_review_cap := v_target - least(v_min_new, v_new_avail);

  -- 1. Words due for review by the end of the learner's local day.
  --    Frequently-wrong words first, then the ones most likely forgotten (lowest predicted recall).
  v_due := array(
    select p.word_id
      from vocabulary_progress p
     where p.user_id = p_user_id
       and p.next_review_at < v_day_end
     order by (p.times_incorrect > p.times_correct) desc,
              fsrs_retrievability(p.stability, coalesce(p.last_review_at, p.last_seen_at), v_day_start),
              p.next_review_at, p.word_id
     limit v_review_cap);

  -- 2. Up to two frequently-wrong words that are not due yet (not seen today).
  v_struggling := array(
    select p.word_id
      from vocabulary_progress p
     where p.user_id = p_user_id
       and p.next_review_at >= v_day_end
       and p.times_incorrect >= 2
       and p.times_incorrect >= p.times_correct
       and p.last_seen_at < v_day_start
     order by p.times_incorrect - p.times_correct desc, p.difficulty desc, p.word_id
     limit least(2, v_review_cap - cardinality(v_due)));

  v_reviews := v_due || v_struggling;

  -- 3. New words: learner's level first, then lower levels, then higher ones.
  --    Within a level, interleave topics (topic_rank) by frequency for variety.
  v_new := array(
    select c.id
      from (
        select w.id,
               w.frequency_rank,
               case
                 when cefr_rank(w.cefr_level) = v_user_rank then 0
                 when cefr_rank(w.cefr_level) < v_user_rank then v_user_rank - cefr_rank(w.cefr_level)
                 else 3 + cefr_rank(w.cefr_level) - v_user_rank
               end as level_priority,
               w.topic
          from vocabulary_words w
         where not exists (select 1 from vocabulary_progress p
                            where p.user_id = p_user_id and p.word_id = w.id)
      ) c
     order by c.level_priority,
              row_number() over (partition by c.level_priority, c.topic order by c.frequency_rank, c.id),
              c.frequency_rank,
              c.id
     limit v_target - cardinality(v_reviews));

  -- 4. Out of new words: top up with the earliest upcoming reviews.
  if cardinality(v_reviews) + cardinality(v_new) < v_target then
    v_fill := array(
      select p.word_id
        from vocabulary_progress p
       where p.user_id = p_user_id
         and p.word_id <> all (v_reviews)
       order by p.next_review_at nulls first, p.word_id
       limit v_target - cardinality(v_reviews) - cardinality(v_new));
    v_reviews := v_reviews || v_fill;
  end if;

  insert into daily_sessions (user_id, session_date, new_word_count, review_word_count, total_word_count)
  values (p_user_id, p_session_date, cardinality(v_new), cardinality(v_reviews),
          cardinality(v_new) + cardinality(v_reviews))
  on conflict (user_id, session_date) do nothing
  returning * into v_session;

  if not found then
    -- a concurrent call created it first
    select * into v_session from daily_sessions
     where user_id = p_user_id and session_date = p_session_date;
    return v_session;
  end if;

  insert into daily_session_words (session_id, word_id, position, kind)
  select v_session.id, x.word_id, x.ord::int, 'new'
    from unnest(v_new) with ordinality as x(word_id, ord);

  insert into daily_session_words (session_id, word_id, position, kind)
  select v_session.id, x.word_id, cardinality(v_new) + x.ord::int, 'review'
    from unnest(v_reviews) with ordinality as x(word_id, ord);

  update vocabulary_progress
     set status = 'review'
   where user_id = p_user_id and word_id = any (v_reviews);

  return v_session;
end;
$$;

create or replace function public.submit_quiz(
  p_session_id       uuid,
  p_duration_seconds int,
  p_answers          jsonb,
  p_schedule         jsonb)
returns public.quiz_attempts
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_now     timestamptz := now();
  v_session public.daily_sessions;
  v_attempt public.quiz_attempts;
  v_score   int;
  v_total   int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_session from daily_sessions
   where id = p_session_id and user_id = v_uid
   for update;
  if not found then
    raise exception 'session not found';
  end if;
  if v_session.status = 'completed' then
    raise exception 'session already completed';
  end if;

  if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_typeof(p_schedule) is distinct from 'array' then
    raise exception 'answers and schedule must be arrays';
  end if;

  -- exactly one answer per session word
  if (select count(*) from jsonb_to_recordset(p_answers) a(word_id int)) <> v_session.total_word_count
     or (select count(distinct a.word_id) from jsonb_to_recordset(p_answers) a(word_id int)) <> v_session.total_word_count
     or exists (select 1 from jsonb_to_recordset(p_answers) a(word_id int)
                 where not exists (select 1 from daily_session_words sw
                                    where sw.session_id = p_session_id and sw.word_id = a.word_id)) then
    raise exception 'answers must cover each session word exactly once';
  end if;

  -- exactly one schedule entry per answered word, with sane values
  if (select count(*) from jsonb_to_recordset(p_schedule) s(word_id int)) <> v_session.total_word_count
     or (select count(distinct s.word_id) from jsonb_to_recordset(p_schedule) s(word_id int)) <> v_session.total_word_count
     or exists (select 1 from jsonb_to_recordset(p_schedule) s(word_id int)
                 where not exists (select 1 from daily_session_words sw
                                    where sw.session_id = p_session_id and sw.word_id = s.word_id))
     or exists (select 1 from jsonb_to_recordset(p_schedule)
                         s(status text, next_review_at timestamptz, stability double precision, fsrs_difficulty double precision)
                 where s.status is null or s.status not in ('learning','familiar','strong')
                    or s.next_review_at is null
                    or s.next_review_at <= v_now
                    or s.next_review_at > v_now + interval '1830 days'
                    -- memory state: both or neither (an app version from before this migration sends neither)
                    or (s.stability is null) <> (s.fsrs_difficulty is null)
                    or s.stability < 0.001 or s.stability > 36500
                    or s.fsrs_difficulty < 1 or s.fsrs_difficulty > 10) then
    raise exception 'invalid schedule';
  end if;

  select count(*) filter (where a.is_correct), count(*)
    into v_score, v_total
    from jsonb_to_recordset(p_answers) a(is_correct boolean);

  insert into quiz_attempts (user_id, daily_session_id, quiz_date, score, total_questions, duration_seconds)
  values (v_uid, p_session_id, v_session.session_date, v_score, v_total,
          greatest(0, coalesce(p_duration_seconds, 0)))
  returning * into v_attempt;

  insert into quiz_answers (quiz_attempt_id, word_id, question_type, user_answer, correct_answer, is_correct)
  select v_attempt.id, a.word_id, a.question_type, coalesce(a.user_answer, ''), a.correct_answer, a.is_correct
    from jsonb_to_recordset(p_answers)
         a(word_id int, question_type text, user_answer text, correct_answer text, is_correct boolean);

  insert into vocabulary_progress as p
         (user_id, word_id, status, streak, difficulty, next_review_at, stability, fsrs_difficulty, last_review_at,
          first_seen_at, last_seen_at, times_seen, times_correct, times_incorrect)
  select v_uid, s.word_id, s.status, s.streak, s.difficulty, s.next_review_at, s.stability, s.fsrs_difficulty,
         case when s.stability is null then null else v_now end,
         v_now, v_now, 1,
         case when a.is_correct then 1 else 0 end,
         case when a.is_correct then 0 else 1 end
    from jsonb_to_recordset(p_schedule)
         s(word_id int, status text, streak int, difficulty int, next_review_at timestamptz,
           stability double precision, fsrs_difficulty double precision)
    join jsonb_to_recordset(p_answers) a(word_id int, is_correct boolean) using (word_id)
  on conflict (user_id, word_id) do update set
    status          = excluded.status,
    streak          = excluded.streak,
    difficulty      = excluded.difficulty,
    next_review_at  = excluded.next_review_at,
    -- without a memory state in the submission, keep the stored one untouched
    stability       = coalesce(excluded.stability, p.stability),
    fsrs_difficulty = coalesce(excluded.fsrs_difficulty, p.fsrs_difficulty),
    last_review_at  = case when excluded.stability is null then p.last_review_at else excluded.last_review_at end,
    first_seen_at   = coalesce(p.first_seen_at, excluded.first_seen_at),
    last_seen_at    = excluded.last_seen_at,
    times_seen      = p.times_seen + 1,
    times_correct   = p.times_correct + excluded.times_correct,
    times_incorrect = p.times_incorrect + excluded.times_incorrect;

  update daily_sessions
     set status = 'completed', quiz_score = v_score, completed_at = v_now
   where id = p_session_id;

  return v_attempt;
end;
$$;

revoke execute on function public.fsrs_retrievability(double precision, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.create_daily_session_for(uuid, date) from public, anon, authenticated;
revoke execute on function public.submit_quiz(uuid, int, jsonb, jsonb) from public, anon;
grant  execute on function public.submit_quiz(uuid, int, jsonb, jsonb) to authenticated;
