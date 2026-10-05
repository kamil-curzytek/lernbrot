-- Lernbrot database update (2026-10-05). For a project that already ran setup.sql before this date.
-- Paste into Supabase SQL Editor and click Run. Safe to run more than once.

-- ===== supabase/migrations/20261005000004_resume_and_target.sql =====
-- 1. Resume where you left off: the study card position and each quiz answer are
--    saved as the learner goes, so leaving the lesson (or switching device) loses nothing.
-- 2. Daily word target: 5..50 in steps of 5, changeable at any time.

-- ---------------------------------------------------------------------------
-- Resume state on the session
-- ---------------------------------------------------------------------------
alter table public.daily_sessions
  add column if not exists study_position int not null default 0 check (study_position >= 0),
  -- {"startedAt": timestamptz, "answers": {"<wordId>:<type>": "<answer>"}}
  add column if not exists quiz_draft jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Daily target: 5..50, multiples of 5
-- ---------------------------------------------------------------------------
update public.profiles
   set daily_word_target = least(50, greatest(5, (round(daily_word_target / 5.0) * 5)::int))
 where daily_word_target not between 5 and 50 or daily_word_target % 5 <> 0;

alter table public.profiles drop constraint if exists profiles_daily_word_target_check;
alter table public.profiles add constraint profiles_daily_word_target_check
  check (daily_word_target between 5 and 50 and daily_word_target % 5 = 0);

-- ---------------------------------------------------------------------------
-- save_session_progress: called after every study card and every quiz answer.
-- The study position only moves forward; a saved quiz answer is never overwritten.
-- ---------------------------------------------------------------------------
create or replace function public.save_session_progress(
  p_session_id     uuid,
  p_study_position int  default null,
  p_question_id    text default null,
  p_answer         text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_session public.daily_sessions;
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

  if p_question_id is not null then
    -- question ids look like "<wordId>:<type>" and must belong to this session
    if p_question_id !~ '^[0-9]{1,9}:[a-z_]{1,20}$'
       or p_answer is null or length(p_answer) > 200
       or not exists (select 1 from daily_session_words sw
                       where sw.session_id = p_session_id
                         and sw.word_id = split_part(p_question_id, ':', 1)::int) then
      raise exception 'invalid answer';
    end if;
  end if;

  update daily_sessions s
     set study_position = case
           when p_study_position is null then s.study_position
           else greatest(s.study_position, least(p_study_position, s.total_word_count))
         end,
         quiz_draft = case
           when p_question_id is null then s.quiz_draft
           else jsonb_build_object(
                  'startedAt', coalesce(s.quiz_draft -> 'startedAt', to_jsonb(now())),
                  -- right side wins in ||, so an answer that is already saved is kept
                  'answers', jsonb_build_object(p_question_id, p_answer)
                             || coalesce(s.quiz_draft -> 'answers', '{}'::jsonb))
         end
   where s.id = p_session_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_daily_target: saves the new target. If today's session has not been
-- touched yet, it is rebuilt with the new size right away.
-- Returns {"profile": <row>, "today_updated": bool}.
-- ---------------------------------------------------------------------------
create or replace function public.update_daily_target(p_target int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_profile public.profiles;
  v_today   date;
  v_rebuilt boolean := false;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update profiles set daily_word_target = p_target where id = v_uid returning * into v_profile;
  if not found then
    raise exception 'profile not found';
  end if;

  if v_profile.onboarded_at is not null then
    v_today := (now() at time zone v_profile.timezone)::date;
    delete from daily_sessions
     where user_id = v_uid
       and session_date = v_today
       and status = 'ready'
       and study_position = 0
       and quiz_draft = '{}'::jsonb
       and total_word_count <> p_target;
    if found then
      perform create_daily_session_for(v_uid, v_today);
      v_rebuilt := true;
    end if;
  end if;

  return jsonb_build_object('profile', to_jsonb(v_profile), 'today_updated', v_rebuilt);
end;
$$;

revoke execute on function public.save_session_progress(uuid, int, text, text) from public, anon;
revoke execute on function public.update_daily_target(int) from public, anon;
grant  execute on function public.save_session_progress(uuid, int, text, text) to authenticated;
grant  execute on function public.update_daily_target(int) to authenticated;

-- make the API see the new columns and functions immediately
notify pgrst, 'reload schema';

-- ===== supabase/migrations/20261005000005_adaptive_new_words.sql =====
-- New words adapt to the review backlog (found by a 60-day simulation: with a fixed
-- minimum of 2 new words a day at 10 words/day, overdue reviews grew without limit).
-- Replaces create_daily_session_for from 20261001000002_functions.sql; same signature.

-- ---------------------------------------------------------------------------
-- create_daily_session_for: the single implementation of "Today's 10".
-- Idempotent: returns the existing session for (user, date) if there is one.
-- Internal: callable by the job (postgres) and by create_my_daily_session().
-- ---------------------------------------------------------------------------
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
  --    Frequently-wrong words first, then the most overdue.
  v_due := array(
    select p.word_id
      from vocabulary_progress p
     where p.user_id = p_user_id
       and p.next_review_at < v_day_end
     order by (p.times_incorrect > p.times_correct) desc, p.next_review_at, p.difficulty desc, p.word_id
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

revoke execute on function public.create_daily_session_for(uuid, date) from public, anon, authenticated;

notify pgrst, 'reload schema';
