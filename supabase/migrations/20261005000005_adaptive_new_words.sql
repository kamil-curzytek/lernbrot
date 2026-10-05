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
