-- Lernbrot: complete setup for a NEW Supabase project. Paste into Supabase SQL Editor and click Run (once).
-- Generated from supabase/migrations/* + supabase/seed/content.sql

-- ===== supabase/migrations/20261001000001_schema.sql =====
-- Germanizer MVP schema.
-- Supabase is the source of truth for content, progress, schedule and sessions.
-- Every user-owned table has RLS enabled. Clients read their own rows directly;
-- all writes except profile settings go through validated RPCs (see 0002).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.cefr_rank(level text)
returns int language sql immutable as $$
  select case level when 'A1' then 1 when 'A2' then 2 when 'B1' then 3 when 'B2' then 4 end
$$;

create or replace function public.is_valid_timezone(tz text)
returns boolean language sql stable as $$
  select exists (select 1 from pg_timezone_names where name = tz)
$$;

-- ---------------------------------------------------------------------------
-- profiles (one per auth user, created by trigger)
-- ---------------------------------------------------------------------------

create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  current_cefr_level text not null default 'A1' check (current_cefr_level in ('A1','A2','B1','B2')),
  daily_word_target  int  not null default 10 check (daily_word_target between 3 and 30),
  timezone           text not null default 'UTC' check (public.is_valid_timezone(timezone)),
  -- null until the user has completed onboarding; the daily job skips such users
  onboarded_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Shared content
-- ---------------------------------------------------------------------------

-- ids are explicit and stable (assigned in content/vocabulary.json); never reuse an id.
create table public.vocabulary_words (
  id                  int primary key,
  german              text not null,
  english             text not null,
  part_of_speech      text not null check (part_of_speech in
                        ('noun','verb','adjective','adverb','preposition','phrase','pronoun','conjunction')),
  article             text check (article in ('der','die','das')),
  plural              text,
  cefr_level          text not null check (cefr_level in ('A1','A2','B1','B2')),
  frequency_rank      int  not null,
  topic               text not null,
  example_sentence    text not null,
  example_translation text not null,
  usage_note          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((part_of_speech = 'noun') or (article is null and plural is null))
);

create trigger vocabulary_words_updated_at before update on public.vocabulary_words
  for each row execute function public.set_updated_at();

create index vocabulary_words_level_idx on public.vocabulary_words (cefr_level, frequency_rank);

-- content = null means "outline only" (B1/B2 in the MVP)
create table public.grammar_topics (
  id            int primary key,
  slug          text not null unique,
  title         text not null,
  cefr_level    text not null check (cefr_level in ('A1','A2','B1','B2')),
  planned_order int  not null,
  summary       text not null,
  content       jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (cefr_level, planned_order)
);

create trigger grammar_topics_updated_at before update on public.grammar_topics
  for each row execute function public.set_updated_at();

create table public.vocabulary_grammar_links (
  word_id  int not null references public.vocabulary_words (id) on delete cascade,
  topic_id int not null references public.grammar_topics (id) on delete cascade,
  primary key (word_id, topic_id)
);

-- ---------------------------------------------------------------------------
-- Learner state
-- ---------------------------------------------------------------------------

create table public.vocabulary_progress (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  word_id         int  not null references public.vocabulary_words (id) on delete cascade,
  status          text not null default 'new' check (status in ('new','learning','familiar','strong','review')),
  first_seen_at   timestamptz,
  last_seen_at    timestamptz,
  next_review_at  timestamptz,
  times_seen      int not null default 0 check (times_seen >= 0),
  times_correct   int not null default 0 check (times_correct >= 0),
  times_incorrect int not null default 0 check (times_incorrect >= 0),
  streak          int not null default 0 check (streak >= 0),
  difficulty      int not null default 0 check (difficulty between 0 and 10),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, word_id)
);

create trigger vocabulary_progress_updated_at before update on public.vocabulary_progress
  for each row execute function public.set_updated_at();

create index vocabulary_progress_due_idx on public.vocabulary_progress (user_id, next_review_at);

create table public.daily_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  session_date      date not null,
  new_word_count    int  not null,
  review_word_count int  not null,
  total_word_count  int  not null,
  status            text not null default 'ready' check (status in ('ready','completed')),
  quiz_score        int,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  -- makes session creation (app + daily job) idempotent
  unique (user_id, session_date),
  check (total_word_count = new_word_count + review_word_count)
);

create table public.daily_session_words (
  session_id uuid not null references public.daily_sessions (id) on delete cascade,
  word_id    int  not null references public.vocabulary_words (id),
  position   int  not null,
  kind       text not null check (kind in ('new','review')),
  primary key (session_id, word_id),
  unique (session_id, position)
);

create table public.quiz_attempts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  -- one scored attempt per daily session, so a word's schedule is updated once per day
  daily_session_id uuid not null unique references public.daily_sessions (id) on delete cascade,
  quiz_date        date not null,
  score            int  not null check (score >= 0),
  total_questions  int  not null check (total_questions > 0 and score <= total_questions),
  duration_seconds int  not null check (duration_seconds >= 0),
  created_at       timestamptz not null default now()
);

create index quiz_attempts_user_idx on public.quiz_attempts (user_id, quiz_date desc);

create table public.quiz_answers (
  id              uuid primary key default gen_random_uuid(),
  quiz_attempt_id uuid not null references public.quiz_attempts (id) on delete cascade,
  word_id         int  not null references public.vocabulary_words (id),
  question_type   text not null check (question_type in
                    ('de_en','en_de','context','fill_blank','en_de_typed','article','plural')),
  user_answer     text not null,
  correct_answer  text not null,
  is_correct      boolean not null,
  created_at      timestamptz not null default now()
);

-- Audit trail for the cloud job, so "did it run while my PC was off?" is answerable.
create table public.daily_job_runs (
  id               bigint generated always as identity primary key,
  ran_at           timestamptz not null default now(),
  profiles_checked int not null,
  sessions_created int not null
);

-- ---------------------------------------------------------------------------
-- Privileges + Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles                 enable row level security;
alter table public.vocabulary_words         enable row level security;
alter table public.grammar_topics           enable row level security;
alter table public.vocabulary_grammar_links enable row level security;
alter table public.vocabulary_progress      enable row level security;
alter table public.daily_sessions           enable row level security;
alter table public.daily_session_words      enable row level security;
alter table public.quiz_attempts            enable row level security;
alter table public.quiz_answers             enable row level security;
alter table public.daily_job_runs           enable row level security;

-- Start from nothing, then grant exactly what the app needs.
revoke all on all tables in schema public from anon, authenticated;

grant select on public.vocabulary_words, public.grammar_topics, public.vocabulary_grammar_links to authenticated;
grant select on public.profiles, public.vocabulary_progress, public.daily_sessions,
               public.daily_session_words, public.quiz_attempts, public.quiz_answers to authenticated;
-- profile settings are the only direct client write
grant update (current_cefr_level, daily_word_target, timezone, onboarded_at) on public.profiles to authenticated;

create policy "content readable by signed-in users" on public.vocabulary_words
  for select to authenticated using (true);
create policy "grammar readable by signed-in users" on public.grammar_topics
  for select to authenticated using (true);
create policy "links readable by signed-in users" on public.vocabulary_grammar_links
  for select to authenticated using (true);

create policy "own profile: read" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "own profile: update" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "own progress: read" on public.vocabulary_progress
  for select to authenticated using (user_id = auth.uid());

create policy "own sessions: read" on public.daily_sessions
  for select to authenticated using (user_id = auth.uid());

create policy "own session words: read" on public.daily_session_words
  for select to authenticated using (
    exists (select 1 from public.daily_sessions s where s.id = session_id and s.user_id = auth.uid()));

create policy "own attempts: read" on public.quiz_attempts
  for select to authenticated using (user_id = auth.uid());

create policy "own answers: read" on public.quiz_answers
  for select to authenticated using (
    exists (select 1 from public.quiz_attempts a where a.id = quiz_attempt_id and a.user_id = auth.uid()));

-- daily_job_runs: RLS on, no policies -> invisible to anon/authenticated.

-- ===== supabase/migrations/20261001000002_functions.sql =====
-- Deterministic learning logic that must run in the cloud (the daily job runs
-- inside Postgres via pg_cron, so session selection lives here, next to the data).
-- Spaced-repetition intervals are computed in TypeScript (src/lib/spacedRepetition)
-- and submitted through submit_quiz(), which validates and stores them atomically.

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
  -- keep a trickle of new words even when many reviews are overdue (10 -> at least 2 new)
  v_min_new   := ceil(v_target * 0.2)::int;
  v_day_start := p_session_date::timestamp at time zone v_profile.timezone;
  v_day_end   := (p_session_date + 1)::timestamp at time zone v_profile.timezone;
  v_user_rank := cefr_rank(v_profile.current_cefr_level);

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

-- ---------------------------------------------------------------------------
-- create_my_daily_session: what the app calls. Uses the caller's own timezone.
-- ---------------------------------------------------------------------------
create or replace function public.create_my_daily_session()
returns public.daily_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_tz  text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select timezone into v_tz from profiles where id = v_uid and onboarded_at is not null;
  if not found then
    raise exception 'complete onboarding first';
  end if;

  return create_daily_session_for(v_uid, (now() at time zone v_tz)::date);
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_quiz: stores the attempt, every answer, and the new review schedule
-- in one transaction. One scored attempt per session.
--
-- p_answers:  [{word_id, question_type, user_answer, correct_answer, is_correct}]
-- p_schedule: [{word_id, status, streak, difficulty, next_review_at}]  (from spacedRepetition)
-- ---------------------------------------------------------------------------
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
     or exists (select 1 from jsonb_to_recordset(p_schedule) s(status text, next_review_at timestamptz)
                 where s.status is null or s.status not in ('learning','familiar','strong')
                    or s.next_review_at is null
                    or s.next_review_at <= v_now
                    or s.next_review_at > v_now + interval '400 days') then
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
         (user_id, word_id, status, streak, difficulty, next_review_at,
          first_seen_at, last_seen_at, times_seen, times_correct, times_incorrect)
  select v_uid, s.word_id, s.status, s.streak, s.difficulty, s.next_review_at,
         v_now, v_now, 1,
         case when a.is_correct then 1 else 0 end,
         case when a.is_correct then 0 else 1 end
    from jsonb_to_recordset(p_schedule)
         s(word_id int, status text, streak int, difficulty int, next_review_at timestamptz)
    join jsonb_to_recordset(p_answers) a(word_id int, is_correct boolean) using (word_id)
  on conflict (user_id, word_id) do update set
    status          = excluded.status,
    streak          = excluded.streak,
    difficulty      = excluded.difficulty,
    next_review_at  = excluded.next_review_at,
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

-- ---------------------------------------------------------------------------
-- run_daily_learning_job: the cloud job (scheduled hourly by pg_cron, 0003).
-- For each onboarded learner whose local time is past p_min_local_hour and who
-- has no session for their local date yet, prepares today's session.
-- Hourly + local-hour gate = every timezone gets its session early in its morning.
-- ---------------------------------------------------------------------------
create or replace function public.run_daily_learning_job(
  p_now            timestamptz default now(),
  p_min_local_hour int default 3)
returns int
language plpgsql security definer set search_path = public as $$
declare
  r         record;
  v_local   timestamp;
  v_checked int := 0;
  v_created int := 0;
begin
  for r in select id, timezone from profiles where onboarded_at is not null order by id loop
    v_checked := v_checked + 1;
    v_local := p_now at time zone r.timezone;
    if extract(hour from v_local) >= p_min_local_hour
       and not exists (select 1 from daily_sessions
                        where user_id = r.id and session_date = v_local::date) then
      begin
        perform create_daily_session_for(r.id, v_local::date);
        v_created := v_created + 1;
      exception when others then
        -- one bad profile must not stop everyone else's lesson
        raise warning 'daily session for % failed: %', r.id, sqlerrm;
      end;
    end if;
  end loop;

  insert into daily_job_runs (profiles_checked, sessions_created) values (v_checked, v_created);
  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: internal functions are not callable from the API.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_daily_session_for(uuid, date) from public, anon, authenticated;
revoke execute on function public.run_daily_learning_job(timestamptz, int) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

revoke execute on function public.create_my_daily_session() from public, anon;
revoke execute on function public.submit_quiz(uuid, int, jsonb, jsonb) from public, anon;
grant  execute on function public.create_my_daily_session() to authenticated;
grant  execute on function public.submit_quiz(uuid, int, jsonb, jsonb) to authenticated;

-- ===== supabase/migrations/20261001000003_daily_cron.sql =====
-- Cloud scheduling: pg_cron runs inside the Supabase database, so the daily job
-- keeps running when the learner's PC is off.
--
-- Runs at minute 5 of every hour. run_daily_learning_job() only creates a session
-- once the learner's local time is past 03:00 and none exists for their local date,
-- so running hourly serves every timezone and repeated runs are harmless.

create extension if not exists pg_cron;

-- cron.schedule with an existing job name replaces that job (safe to re-run).
select cron.schedule(
  'germanizer-daily-learning-job',
  '5 * * * *',
  $$select public.run_daily_learning_job()$$
);

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

-- ===== supabase/seed/content.sql =====
-- GENERATED by scripts/build-seed.mjs from content/*.json. Do not edit by hand.
-- Idempotent: safe to run repeatedly.
begin;
insert into public.grammar_topics (id, slug, title, cefr_level, planned_order, summary, content) values
  (101, 'sein-haben', 'sein & haben', 'A1', 1, 'The two verbs you use in almost every sentence.', '{"what":"sein (to be) and haben (to have) are irregular and extremely common. You also need them later to build the past tense.","rule":"sein: ich bin, du bist, er/sie/es ist, wir sind, ihr seid, sie/Sie sind.\nhaben: ich habe, du hast, er/sie/es hat, wir haben, ihr habt, sie/Sie haben.","examples":[{"de":"Ich bin müde.","en":"I''m tired."},{"de":"Wir haben keine Zeit.","en":"We don''t have time."},{"de":"Bist du zu Hause?","en":"Are you at home?"}],"mistake":{"wrong":"Ich habe 30 Jahre.","right":"Ich bin 30 Jahre alt.","why":"Age uses sein in German, not haben."},"everyday":[{"de":"Ich habe Hunger.","en":"I''m hungry."},{"de":"Das ist gut!","en":"That''s good!"}],"remember":"Hunger, Durst, Zeit: you HAVE them (haben). Age, tired, ready: you ARE (sein)."}'::jsonb),
  (102, 'personal-pronouns', 'Personal pronouns', 'A1', 2, 'ich, du, er, sie, es … and the polite Sie.', '{"what":"Pronouns replace names: I, you, he, she, it, we, they.","rule":"ich, du, er, sie, es, wir, ihr, sie. Polite ''you'' (singular or plural) is Sie, always with a capital S.","examples":[{"de":"Das ist Anna. Sie wohnt in Köln.","en":"This is Anna. She lives in Cologne."},{"de":"Kommt ihr mit?","en":"Are you (all) coming?"}],"mistake":{"wrong":"Können sie mir helfen? (to a stranger)","right":"Können Sie mir helfen?","why":"Lower-case sie means ''they''. Use capital Sie for polite ''you''."},"everyday":[{"de":"Woher kommen Sie?","en":"Where are you from?"},{"de":"Und du?","en":"And you?"}],"remember":"du for friends and family, Sie for strangers, shops and offices."}'::jsonb),
  (103, 'present-tense', 'Present tense', 'A1', 3, 'Regular endings, plus the common verbs that change their vowel.', '{"what":"The present tense covers ''I work'', ''I''m working'' and often the future too (''Morgen arbeite ich'').","rule":"Stem + ending: ich -e, du -st, er/sie/es -t, wir -en, ihr -t, sie/Sie -en. Some verbs change the vowel for du and er/sie/es: fahren → du fährst, sprechen → er spricht, lesen → sie liest.","examples":[{"de":"Ich arbeite in einem Büro.","en":"I work in an office."},{"de":"Er fährt mit dem Bus.","en":"He goes by bus."},{"de":"Was machst du heute?","en":"What are you doing today?"}],"mistake":{"wrong":"Er fahrt nach Berlin.","right":"Er fährt nach Berlin.","why":"fahren changes a → ä for du and er/sie/es."},"everyday":[{"de":"Ich komme gleich.","en":"I''m coming / I''ll be right there."},{"de":"Sprichst du Englisch?","en":"Do you speak English?"}],"remember":"German has no ''I am working'' form. ''Ich arbeite'' covers both."}'::jsonb),
  (104, 'word-order', 'Word order: verb in position 2', 'A1', 4, 'The conjugated verb is always the second element.', '{"what":"In a normal statement the conjugated verb is the second element. Anything can come first, and then the subject moves behind the verb.","rule":"Position 1 (one element) → verb → rest. If you start with time or place, the subject comes right after the verb. und, aber, oder do not change the word order.","examples":[{"de":"Ich gehe heute ins Kino.","en":"I''m going to the cinema today."},{"de":"Heute gehe ich ins Kino.","en":"Today I''m going to the cinema."},{"de":"Ich bin müde, aber ich muss arbeiten.","en":"I''m tired, but I have to work."}],"mistake":{"wrong":"Morgen ich fahre nach Köln.","right":"Morgen fahre ich nach Köln.","why":"The verb must stay in position 2. ''Morgen'' already takes position 1."},"everyday":[{"de":"Am Wochenende habe ich Zeit.","en":"I have time at the weekend."}],"remember":"Verb second. Always. Even if a time word comes first."}'::jsonb),
  (105, 'questions', 'Asking questions', 'A1', 5, 'W-questions and yes/no questions.', '{"what":"There are two kinds of questions: with a question word (wer, was, wo, wann…) and yes/no questions.","rule":"W-question: question word → verb → subject. Yes/no question: verb first. Wo = where (location), wohin = where to, woher = where from.","examples":[{"de":"Wo wohnst du?","en":"Where do you live?"},{"de":"Wann kommt der Zug?","en":"When does the train come?"},{"de":"Hast du Zeit?","en":"Do you have time?"}],"mistake":{"wrong":"Wo gehst du? (meaning: where to?)","right":"Wohin gehst du?","why":"Movement towards a place uses wohin."},"everyday":[{"de":"Wie viel kostet das?","en":"How much is it?"},{"de":"Was ist los?","en":"What''s up?"}],"remember":"No ''do'' in German questions. Just put the verb first: Kommst du?"}'::jsonb),
  (106, 'negation', 'Negation: nicht & kein', 'A1', 6, 'When to say nicht and when to say kein.', '{"what":"German has two ways to say ''not'': nicht and kein.","rule":"kein replaces ein/eine or no article: kein Auto, keine Zeit, kein Geld. nicht negates everything else: verbs, adjectives, names, nouns with der/die/das.","examples":[{"de":"Ich habe keine Zeit.","en":"I don''t have time."},{"de":"Das ist nicht teuer.","en":"That''s not expensive."},{"de":"Ich komme heute nicht.","en":"I''m not coming today."}],"mistake":{"wrong":"Ich habe nicht Geld.","right":"Ich habe kein Geld.","why":"A noun without an article is negated with kein."},"everyday":[{"de":"Kein Problem!","en":"No problem!"},{"de":"Ich weiß es nicht.","en":"I don''t know."}],"remember":"kein = ''not a'' / ''no'' before a noun. nicht = ''not'' for the rest."}'::jsonb),
  (107, 'articles', 'Articles: der, die, das', 'A1', 7, 'Every noun has a gender. Learn it with the word.', '{"what":"Every German noun is masculine (der), feminine (die) or neuter (das). The plural is always die.","rule":"Definite: der / die / das, plural die. Indefinite: ein / eine / ein, with no plural. Some helpful patterns: -ung, -heit, -keit → die; -chen → das.","examples":[{"de":"der Termin, die Wohnung, das Zimmer","en":"the appointment, the flat, the room"},{"de":"Ich habe eine Frage.","en":"I have a question."}],"mistake":{"wrong":"Termin = appointment","right":"der Termin, die Termine = appointment","why":"Write down every noun with its article and plural. That''s why the cards show der/die/das."},"everyday":[{"de":"Die Rechnung, bitte.","en":"The bill, please."}],"remember":"Never learn a noun without its article."}'::jsonb),
  (108, 'nominative', 'Nominative: the subject', 'A1', 8, 'Who or what is doing the action.', '{"what":"The nominative is the dictionary form, used for the subject of the sentence.","rule":"Ask ''wer?'' or ''was?''. The answer is the nominative: der Mann, die Frau, das Kind, ein Termin.","examples":[{"de":"Der Zug kommt.","en":"The train is coming."},{"de":"Das ist mein Kollege.","en":"That''s my colleague."}],"mistake":{"wrong":"Den Bus ist voll.","right":"Der Bus ist voll.","why":"The bus is the subject, so it takes nominative der."},"everyday":[{"de":"Wer ist das?","en":"Who''s that?"}],"remember":"After sein, both sides are nominative: Das ist der Chef."}'::jsonb),
  (109, 'accusative', 'Accusative: the direct object', 'A1', 9, 'Only der changes: der → den, ein → einen.', '{"what":"The accusative marks the direct object, the thing you have, buy, need or see.","rule":"Only masculine changes: der → den, ein → einen, kein → keinen. die, das and plural stay the same. Prepositions für, ohne, durch, gegen, um always take the accusative.","examples":[{"de":"Ich habe einen Termin.","en":"I have an appointment."},{"de":"Ich brauche den Schlüssel.","en":"I need the key."},{"de":"Das ist für dich.","en":"That''s for you."}],"mistake":{"wrong":"Ich kaufe ein Kaffee.","right":"Ich kaufe einen Kaffee.","why":"Kaffee is masculine (der), so the object form is einen."},"everyday":[{"de":"Ich nehme den Bus.","en":"I''m taking the bus."}],"remember":"Accusative = only ''der'' words change (den / einen)."}'::jsonb),
  (110, 'dative', 'Dative basics', 'A1', 10, 'To whom? With mit, bei, nach, zu, von, aus, seit, and verbs like helfen.', '{"what":"The dative is used for ''to/for someone'', after certain prepositions and after a few common verbs.","rule":"der → dem, die → der, das → dem, plural → den (+n). Always dative: mit, nach, bei, seit, von, zu, aus. Verbs: helfen, danken, gefallen, gehören. Short forms: zum = zu dem, zur = zu der, beim = bei dem, vom = von dem.","examples":[{"de":"Ich fahre mit dem Bus.","en":"I''m going by bus."},{"de":"Kannst du mir helfen?","en":"Can you help me?"},{"de":"Ich gehe zum Arzt.","en":"I''m going to the doctor."}],"mistake":{"wrong":"Ich helfe dich.","right":"Ich helfe dir.","why":"helfen always takes the dative: mir, dir, ihm, ihr, uns, euch, Ihnen."},"everyday":[{"de":"Wie geht es dir?","en":"How are you?"},{"de":"Das gefällt mir.","en":"I like it."}],"remember":"mit, nach, bei, seit, von, zu, aus: always dative."}'::jsonb),
  (111, 'modal-verbs', 'Modal verbs', 'A1', 11, 'können, müssen, wollen, möchten, dürfen, sollen + infinitive at the end.', '{"what":"Modal verbs say whether you can, must, want to or may do something.","rule":"The modal verb is conjugated in position 2. The main verb goes to the END in the infinitive. ich/er forms have no ending: ich kann, er muss, sie will.","examples":[{"de":"Ich kann heute nicht kommen.","en":"I can''t come today."},{"de":"Wir müssen um acht aufstehen.","en":"We have to get up at eight."},{"de":"Darf ich hier rauchen?","en":"May I smoke here?"}],"mistake":{"wrong":"Ich muss gehen nach Hause.","right":"Ich muss nach Hause gehen.","why":"The infinitive goes to the very end."},"everyday":[{"de":"Ich möchte bitte bezahlen.","en":"I''d like to pay, please."},{"de":"Kannst du mich abholen?","en":"Can you pick me up?"}],"remember":"Modal in position 2, infinitive at the end, like a bracket."}'::jsonb),
  (112, 'separable-verbs', 'Separable verbs', 'A1', 12, 'anrufen → Ich rufe dich an.', '{"what":"Many verbs have a prefix (an-, auf-, ein-, mit-, ab-, aus-, um-…) that splits off and goes to the end.","rule":"In a normal sentence the verb goes in position 2 and the prefix goes to the end. With a modal verb, or in the infinitive, the verb stays together: Ich muss dich anrufen.","examples":[{"de":"Ich rufe dich später an.","en":"I''ll call you later."},{"de":"Wann stehst du auf?","en":"When do you get up?"},{"de":"Ich muss noch einkaufen.","en":"I still have to do the shopping."}],"mistake":{"wrong":"Ich anrufe dich morgen.","right":"Ich rufe dich morgen an.","why":"The prefix an- moves to the end of the sentence."},"everyday":[{"de":"Kommst du mit?","en":"Are you coming along?"},{"de":"Steig hier aus.","en":"Get off here."}],"remember":"Prefix to the end. With a modal verb, it''s all together at the end."}'::jsonb),
  (113, 'possessives', 'Possessives: mein, dein, sein…', 'A1', 13, 'my, your, his, her, our, their.', '{"what":"Possessive words say who something belongs to. They take the same endings as ein/eine.","rule":"mein, dein, sein (his/its), ihr (her/their), unser, euer, Ihr (polite). Feminine and plural add -e: meine Wohnung. Masculine accusative adds -en: meinen Schlüssel.","examples":[{"de":"Das ist meine Familie.","en":"This is my family."},{"de":"Ich suche meinen Schlüssel.","en":"I''m looking for my key."},{"de":"Wie ist Ihr Name?","en":"What''s your name?"}],"mistake":{"wrong":"Anna und sein Bruder","right":"Anna und ihr Bruder","why":"Use ihr for ''her''. sein means ''his''."},"everyday":[{"de":"Ist das dein Handy?","en":"Is that your phone?"}],"remember":"Endings work like ein: mein / meine / mein, accusative meinen."}'::jsonb),
  (114, 'prepositions', 'Common prepositions', 'A1', 14, 'in, an, auf, mit, nach, zu, bei, von, aus, für, ohne, um.', '{"what":"A handful of prepositions cover most everyday situations: places, times and directions.","rule":"Time: um 8 Uhr, am Montag, im Mai. Going places: zu + person/building (zum Arzt), nach + city, country, home (nach Berlin, nach Hause), in + building you enter (ins Kino). Being somewhere: bei + person (bei Anna), zu Hause = at home.","examples":[{"de":"Ich gehe zum Supermarkt.","en":"I''m going to the supermarket."},{"de":"Wir fahren nach Hamburg.","en":"We''re going to Hamburg."},{"de":"Der Kurs ist am Montag um sechs.","en":"The course is on Monday at six."}],"mistake":{"wrong":"Ich gehe nach dem Arzt.","right":"Ich gehe zum Arzt.","why":"Use zu for people and most buildings. nach is for cities, countries and home."},"everyday":[{"de":"Ich bin zu Hause.","en":"I''m at home."},{"de":"Ich gehe nach Hause.","en":"I''m going home."}],"remember":"zu Hause = at home. nach Hause = (going) home."}'::jsonb),
  (115, 'perfekt', 'Perfekt: talking about the past', 'A1', 15, 'haben/sein + past participle at the end.', '{"what":"In spoken German you talk about the past with the Perfekt: ''Ich habe gegessen''.","rule":"haben (or sein) in position 2 + past participle at the end. Regular: ge- + stem + -t (machen → gemacht). Many common verbs are irregular (essen → gegessen, gehen → gegangen). Verbs of movement use sein: Ich bin gefahren.","examples":[{"de":"Ich habe heute viel gearbeitet.","en":"I worked a lot today."},{"de":"Wir sind nach Berlin gefahren.","en":"We went to Berlin."},{"de":"Hast du schon gegessen?","en":"Have you eaten yet?"}],"mistake":{"wrong":"Ich habe gegangen.","right":"Ich bin gegangen.","why":"gehen is movement from A to B, so it takes sein."},"everyday":[{"de":"Was hast du am Wochenende gemacht?","en":"What did you do at the weekend?"}],"remember":"Movement (gehen, fahren, kommen) → sein. Almost everything else → haben."}'::jsonb),
  (116, 'imperative', 'Imperative: giving instructions', 'A1', 16, 'Komm! Kommt! Kommen Sie!', '{"what":"The imperative is for requests and instructions. Add bitte to sound polite.","rule":"du: verb stem without -st and without du (Komm! Nimm!). ihr: same as the ihr form (Kommt!). Sie: verb first + Sie (Kommen Sie!).","examples":[{"de":"Ruf mich bitte an!","en":"Please call me!"},{"de":"Warten Sie bitte einen Moment.","en":"Please wait a moment."},{"de":"Macht die Tür zu!","en":"Close the door (you all)!"}],"mistake":{"wrong":"Du komm her!","right":"Komm her!","why":"The du imperative drops the pronoun du."},"everyday":[{"de":"Sag mal …","en":"Tell me … / Hey, …"},{"de":"Entschuldigen Sie bitte!","en":"Excuse me, please!"}],"remember":"Add bitte: it turns a command into a friendly request."}'::jsonb),
  (201, 'reflexive-verbs', 'Reflexive verbs', 'A2', 1, 'sich erinnern, sich freuen, sich entscheiden…', '{"what":"Some verbs need a reflexive pronoun (myself, yourself…) in German even when English doesn''t use one.","rule":"mich, dich, sich, uns, euch, sich. The pronoun comes right after the conjugated verb (or after the subject if the subject comes after the verb).","examples":[{"de":"Ich erinnere mich nicht.","en":"I don''t remember."},{"de":"Wir freuen uns auf den Urlaub.","en":"We''re looking forward to the holiday."},{"de":"Hast du dich schon entschieden?","en":"Have you decided yet?"}],"mistake":{"wrong":"Ich erinnere an den Termin.","right":"Ich erinnere mich an den Termin.","why":"sich erinnern needs the reflexive pronoun."},"everyday":[{"de":"Ich freue mich!","en":"I''m so pleased!"},{"de":"Beeil dich!","en":"Hurry up!"}],"remember":"Learn these verbs with sich, exactly as the cards show them."}'::jsonb),
  (202, 'subordinate-clauses', 'weil, dass, wenn: verb to the end', 'A2', 2, 'Subordinate clauses send the conjugated verb to the end.', '{"what":"After weil, dass, wenn, obwohl, ob and question words in indirect questions, the conjugated verb goes to the end of the clause.","rule":"Main clause, + weil + subject + … + verb. If the subordinate clause comes first, the main clause starts with the verb: Wenn ich Zeit habe, komme ich.","examples":[{"de":"Ich bleibe zu Hause, weil ich krank bin.","en":"I''m staying at home because I''m ill."},{"de":"Ich glaube, dass der Zug Verspätung hat.","en":"I think the train is late."},{"de":"Wenn du willst, können wir morgen gehen.","en":"If you want, we can go tomorrow."}],"mistake":{"wrong":"…, weil ich bin krank.","right":"…, weil ich krank bin.","why":"After weil the verb goes to the end."},"everyday":[{"de":"Ich weiß nicht, ob ich Zeit habe.","en":"I don''t know if I''ll have time."}],"remember":"weil/dass/wenn → verb at the end. Always a comma before them."}'::jsonb),
  (203, 'two-way-prepositions', 'Two-way prepositions', 'A2', 3, 'in, an, auf, über, unter, vor, hinter, neben, zwischen: where vs. where to.', '{"what":"Nine prepositions take the accusative OR the dative, depending on the question.","rule":"Wohin? (movement to a place) → accusative. Wo? (location) → dative. Verbs: legen/stellen/hängen (put) → accusative, liegen/stehen/hängen (be) → dative.","examples":[{"de":"Ich lege das Handy auf den Tisch.","en":"I put the phone on the table."},{"de":"Das Handy liegt auf dem Tisch.","en":"The phone is on the table."},{"de":"Wir gehen ins Kino. / Wir sind im Kino.","en":"We''re going to the cinema. / We''re at the cinema."}],"mistake":{"wrong":"Ich gehe in der Stadt. (meaning: into town)","right":"Ich gehe in die Stadt.","why":"Movement into town → wohin → accusative."},"everyday":[{"de":"Stell die Tasche bitte neben die Tür.","en":"Put the bag next to the door, please."}],"remember":"Wohin → accusative. Wo → dative."}'::jsonb),
  (204, 'dative-verbs', 'Verbs with the dative', 'A2', 4, 'helfen, danken, gefallen, gehören, passen, schmecken…', '{"what":"A small group of very common verbs take a dative object instead of an accusative one.","rule":"helfen, danken, gefallen, gehören, passen, schmecken, gratulieren, antworten + dative. With gefallen and schmecken the thing is the subject: Der Film gefällt mir.","examples":[{"de":"Die Jacke gefällt mir.","en":"I like the jacket."},{"de":"Wem gehört das Auto?","en":"Whose car is this?"},{"de":"Schmeckt dir der Kuchen?","en":"Do you like the cake?"}],"mistake":{"wrong":"Ich gefalle den Film.","right":"Der Film gefällt mir.","why":"With gefallen the thing you like is the subject. You are the dative."},"everyday":[{"de":"Passt dir Montag?","en":"Does Monday suit you?"}],"remember":"gefallen = ''is pleasing to''. Der Film gefällt mir = The film pleases me."}'::jsonb),
  (205, 'perfekt-sein', 'Perfekt with sein', 'A2', 5, 'Which verbs take sein in the past.', '{"what":"Most verbs form the Perfekt with haben. Verbs of movement and change of state use sein.","rule":"sein + participle: gehen, fahren, kommen, fliegen, laufen, aufstehen, umsteigen (movement); werden, aufwachen, einschlafen (change); plus bleiben and sein itself.","examples":[{"de":"Ich bin um sechs aufgestanden.","en":"I got up at six."},{"de":"Sie ist zu Hause geblieben.","en":"She stayed at home."},{"de":"Wir sind in Köln umgestiegen.","en":"We changed trains in Cologne."}],"mistake":{"wrong":"Ich habe nach Berlin gefahren.","right":"Ich bin nach Berlin gefahren.","why":"fahren (going somewhere) takes sein."},"everyday":[{"de":"Was ist passiert?","en":"What happened?"}],"remember":"From A to B, or from one state to another → sein."}'::jsonb),
  (206, 'praeteritum-basics', 'Präteritum: war, hatte, konnte', 'A2', 6, 'The few simple-past forms you use when speaking.', '{"what":"When speaking, Germans use the simple past mainly for sein, haben and the modal verbs.","rule":"sein → war, haben → hatte, können → konnte, müssen → musste, wollen → wollte. ich and er/sie/es have the same form: ich war, er war.","examples":[{"de":"Gestern war ich beim Arzt.","en":"Yesterday I was at the doctor''s."},{"de":"Ich hatte keine Zeit.","en":"I didn''t have time."},{"de":"Wir mussten lange warten.","en":"We had to wait a long time."}],"mistake":{"wrong":"Ich bin gestern krank gewesen. (sounds heavy)","right":"Ich war gestern krank.","why":"For sein and haben, the simple past is shorter and more natural."},"everyday":[{"de":"Wie war dein Wochenende?","en":"How was your weekend?"}],"remember":"war, hatte, konnte, musste: simple past. Most other verbs: Perfekt."}'::jsonb),
  (207, 'comparative-superlative', 'Comparing: schneller, am schnellsten', 'A2', 7, 'Comparatives and superlatives.', '{"what":"To compare, add -er. For ''the most'', use am …-sten.","rule":"schnell → schneller → am schnellsten. Comparisons use als: schneller als. Equality uses so … wie. Short adjectives often add an umlaut: alt → älter, groß → größer. Irregular: gut → besser → am besten, gern → lieber → am liebsten, viel → mehr → am meisten.","examples":[{"de":"Der Zug ist schneller als der Bus.","en":"The train is faster than the bus."},{"de":"Ich trinke lieber Tee.","en":"I prefer tea."},{"de":"Das ist am besten.","en":"That''s best."}],"mistake":{"wrong":"Er ist größer wie ich.","right":"Er ist größer als ich.","why":"After a comparative, use als."},"everyday":[{"de":"So schnell wie möglich.","en":"As soon as possible."}],"remember":"-er + als. so … wie for ''as … as''."}'::jsonb),
  (208, 'adjective-endings', 'Adjective endings: the basics', 'A2', 8, 'ein neuer Job, der neue Job: just the most common patterns.', '{"what":"An adjective before a noun gets an ending. After the verb (Das Auto ist neu) it gets none.","rule":"After der/die/das (nominative singular): -e (der neue Job, die neue Wohnung). After ein: the adjective shows the gender: ein neuer Job, eine neue Wohnung, ein neues Auto. In most other cases: -en.","examples":[{"de":"Ich habe einen neuen Job.","en":"I have a new job."},{"de":"Das ist ein schönes Zimmer.","en":"That''s a nice room."},{"de":"Die neue Kollegin ist nett.","en":"The new colleague is nice."}],"mistake":{"wrong":"ein neu Auto","right":"ein neues Auto","why":"Before a noun the adjective needs an ending."},"everyday":[{"de":"Schönes Wochenende!","en":"Have a nice weekend!"},{"de":"Guten Morgen!","en":"Good morning!"}],"remember":"When in doubt, -en is the most common ending."}'::jsonb),
  (209, 'polite-requests', 'Polite requests: hätte, könnte, würde', 'A2', 9, 'Ich hätte gern …, Könnten Sie …?, Würden Sie …?', '{"what":"These Konjunktiv II forms make requests softer and more polite, much like ''could'' and ''would'' in English.","rule":"Ich hätte gern + thing. Könnten Sie / Könntest du + infinitive at the end? Würden Sie + infinitive at the end?","examples":[{"de":"Ich hätte gern zwei Brötchen.","en":"I''d like two bread rolls."},{"de":"Könnten Sie mir bitte helfen?","en":"Could you help me, please?"},{"de":"Würden Sie das Fenster aufmachen?","en":"Would you open the window?"}],"mistake":{"wrong":"Ich will einen Kaffee. (in a café)","right":"Ich hätte gern einen Kaffee.","why":"''Ich will'' sounds demanding. hätte gern / möchte is polite."},"everyday":[{"de":"Könnte ich kurz stören?","en":"Could I interrupt for a second?"}],"remember":"In shops and offices: hätte gern, könnten Sie, würden Sie."}'::jsonb),
  (210, 'verbs-with-prepositions', 'Verbs with fixed prepositions', 'A2', 10, 'warten auf, sich freuen auf, sich kümmern um, sich erinnern an…', '{"what":"Many verbs come with a fixed preposition. It often differs from English, so learn the pair together.","rule":"warten auf + Akk, sich freuen auf + Akk (future) / über + Akk (now), sich kümmern um + Akk, sich erinnern an + Akk, Angst haben vor + Dat, sprechen mit + Dat / über + Akk.","examples":[{"de":"Ich warte auf den Bus.","en":"I''m waiting for the bus."},{"de":"Kümmerst du dich um die Katze?","en":"Will you look after the cat?"},{"de":"Erinnerst du dich an ihn?","en":"Do you remember him?"}],"mistake":{"wrong":"Ich warte für den Bus.","right":"Ich warte auf den Bus.","why":"warten goes with auf, not für."},"everyday":[{"de":"Worauf wartest du?","en":"What are you waiting for?"}],"remember":"Learn the verb + preposition as one unit: warten auf."}'::jsonb),
  (211, 'future-werden', 'Future with werden', 'A2', 11, 'werden + infinitive, and why you often don''t need it.', '{"what":"werden + infinitive expresses the future or a prediction. With a time word, the present tense is usually enough.","rule":"ich werde, du wirst, er wird, wir werden + infinitive at the end. ''Morgen fahre ich nach Köln'' is perfectly normal future in German.","examples":[{"de":"Es wird bestimmt regnen.","en":"It''s definitely going to rain."},{"de":"Wir werden mehr Zeit brauchen.","en":"We''ll need more time."}],"mistake":{"wrong":"Ich will morgen arbeiten. (meaning: I will)","right":"Ich werde morgen arbeiten. / Ich arbeite morgen.","why":"''will'' in German means ''want''. The future uses werden."},"everyday":[{"de":"Das wird schon!","en":"It''ll be fine!"}],"remember":"German ''ich will'' = I want. Future = werden, or just the present + a time word."}'::jsonb),
  (212, 'zu-infinitive', 'zu + infinitive', 'A2', 12, 'Ich versuche, pünktlich zu sein.', '{"what":"After many verbs and expressions, a second verb comes with zu at the end.","rule":"versuchen, vergessen, anfangen, aufhören, Lust haben, Zeit haben + zu + infinitive. With separable verbs, zu goes in the middle: anzurufen, aufzustehen. Modal verbs never take zu.","examples":[{"de":"Ich habe vergessen, dich anzurufen.","en":"I forgot to call you."},{"de":"Hast du Lust, ins Kino zu gehen?","en":"Do you fancy going to the cinema?"}],"mistake":{"wrong":"Ich muss zu arbeiten.","right":"Ich muss arbeiten.","why":"Modal verbs never take zu."},"everyday":[{"de":"Ich habe keine Zeit, das zu machen.","en":"I don''t have time to do that."}],"remember":"Modal → no zu. Other verbs → zu + infinitive at the end."}'::jsonb),
  (301, 'genitive', 'Genitive', 'B1', 1, 'des/der, wegen, während, trotz. Mostly in written German.', null),
  (302, 'relative-clauses', 'Relative clauses', 'B1', 2, 'der Mann, der …; die Frau, die …; das Buch, das …', null),
  (303, 'passive-present', 'Passive voice (present & past)', 'B1', 3, 'werden + participle: Das Paket wird geliefert.', null),
  (304, 'konjunktiv-ii', 'Konjunktiv II: wishes & hypotheticals', 'B1', 4, 'Wenn ich Zeit hätte, würde ich …', null),
  (305, 'purpose-clauses', 'damit & um … zu', 'B1', 5, 'Expressing purpose: so that / in order to.', null),
  (306, 'two-part-conjunctions', 'Two-part conjunctions', 'B1', 6, 'sowohl … als auch, entweder … oder, weder … noch, nicht nur … sondern auch.', null),
  (307, 'plusquamperfekt', 'Plusquamperfekt', 'B1', 7, 'hatte/war + participle: what had happened before.', null),
  (308, 'n-declension', 'n-declension', 'B1', 8, 'den Kollegen, dem Nachbarn: masculine nouns that add -n.', null),
  (401, 'passive-alternatives', 'Passive with modals & alternatives', 'B2', 1, 'muss erledigt werden; lässt sich machen; ist zu machen.', null),
  (402, 'konjunktiv-i', 'Konjunktiv I: reported speech', 'B2', 2, 'Er sagt, er habe keine Zeit. The language of news reports.', null),
  (403, 'nominalisation', 'Nominalisation', 'B2', 3, 'Turning verbs into nouns for formal writing: die Umsetzung des Plans.', null),
  (404, 'participle-attributes', 'Participles as adjectives', 'B2', 4, 'die steigenden Mieten, das gestern gekaufte Buch.', null),
  (405, 'advanced-connectors', 'Advanced connectors', 'B2', 5, 'indem, sodass, je … desto, falls, sofern.', null),
  (406, 'modal-particles', 'Modal particles', 'B2', 6, 'doch, mal, ja, eben, halt: sounding natural in conversation.', null)
on conflict (id) do update set
  slug = excluded.slug,
  title = excluded.title,
  cefr_level = excluded.cefr_level,
  planned_order = excluded.planned_order,
  summary = excluded.summary,
  content = excluded.content;

insert into public.vocabulary_words (id, german, english, part_of_speech, article, plural, cefr_level, frequency_rank, topic, example_sentence, example_translation, usage_note) values
  (1, 'Termin', 'appointment', 'noun', 'der', 'Termine', 'A1', 1, 'appointments', 'Ich habe morgen einen Termin beim Arzt.', 'I have a doctor''s appointment tomorrow.', null),
  (2, 'sein', 'to be', 'verb', null, null, 'A1', 2, 'everyday', 'Das kann nicht sein!', 'That can''t be right!', 'Irregular: ich bin, du bist, er ist, wir sind.'),
  (3, 'haben', 'to have', 'verb', null, null, 'A1', 3, 'everyday', 'Kann ich bitte die Rechnung haben?', 'Can I have the bill, please?', 'ich habe, du hast, er hat.'),
  (4, 'heute', 'today', 'adverb', null, null, 'A1', 4, 'time', 'Heute habe ich keine Zeit.', 'I don''t have time today.', null),
  (5, 'Wohnung', 'flat, apartment', 'noun', 'die', 'Wohnungen', 'A1', 5, 'home', 'Unsere Wohnung hat drei Zimmer.', 'Our flat has three rooms.', null),
  (6, 'Arbeit', 'work (the place or activity)', 'noun', 'die', null, 'A1', 6, 'work', 'Ich fahre mit dem Fahrrad zur Arbeit.', 'I cycle to work.', null),
  (7, 'Brot', 'bread', 'noun', 'das', 'Brote', 'A1', 7, 'food', 'Ich kaufe jeden Morgen frisches Brot.', 'I buy fresh bread every morning.', null),
  (8, 'Bahnhof', 'train station', 'noun', 'der', 'Bahnhöfe', 'A1', 8, 'transport', 'Wie komme ich zum Bahnhof?', 'How do I get to the train station?', null),
  (9, 'Familie', 'family', 'noun', 'die', 'Familien', 'A1', 9, 'people', 'Meine Familie wohnt in Hamburg.', 'My family lives in Hamburg.', null),
  (10, 'Handy', 'mobile phone', 'noun', 'das', 'Handys', 'A1', 10, 'communication', 'Mein Handy ist leer.', 'My phone battery is dead.', null),
  (11, 'Geld', 'money', 'noun', 'das', null, 'A1', 11, 'shopping', 'Ich habe kein Geld dabei.', 'I don''t have any money on me.', null),
  (12, 'Urlaub', 'holiday, vacation', 'noun', 'der', 'Urlaube', 'A1', 12, 'travel', 'Im Sommer machen wir Urlaub in Italien.', 'In summer we''re going on holiday to Italy.', null),
  (13, 'gehen', 'to go (on foot), to walk', 'verb', null, null, 'A1', 13, 'everyday', 'Ich muss jetzt nach Hause gehen.', 'I have to go home now.', null),
  (14, 'fahren', 'to go (by vehicle), to drive', 'verb', null, null, 'A1', 14, 'transport', 'Morgen will ich mit dem Zug nach München fahren.', 'Tomorrow I want to take the train to Munich.', 'Stem change: du fährst, er fährt.'),
  (15, 'kommen', 'to come', 'verb', null, null, 'A1', 15, 'everyday', 'Kannst du heute Abend kommen?', 'Can you come this evening?', null),
  (16, 'machen', 'to do, to make', 'verb', null, null, 'A1', 16, 'everyday', 'Was willst du am Wochenende machen?', 'What do you want to do at the weekend?', null),
  (17, 'gut', 'good, well', 'adjective', null, null, 'A1', 17, 'everyday', 'Das Essen hier ist wirklich gut.', 'The food here is really good.', null),
  (18, 'Danke', 'thank you, thanks', 'phrase', null, null, 'A1', 18, 'communication', 'Danke für deine Hilfe!', 'Thanks for your help!', null),
  (19, 'Bitte', 'please; you''re welcome', 'phrase', null, null, 'A1', 19, 'communication', 'Ein Wasser, bitte.', 'A water, please.', null),
  (20, 'Entschuldigung', 'excuse me; sorry', 'phrase', null, null, 'A1', 20, 'communication', 'Entschuldigung, wo ist der Bahnhof?', 'Excuse me, where is the train station?', null),
  (21, 'Zeit', 'time', 'noun', 'die', null, 'A1', 21, 'time', 'Hast du heute Abend Zeit?', 'Are you free this evening?', null),
  (22, 'Arzt', 'doctor', 'noun', 'der', 'Ärzte', 'A1', 22, 'appointments', 'Ich muss heute noch zum Arzt.', 'I still have to go to the doctor today.', 'A female doctor: die Ärztin.'),
  (23, 'arbeiten', 'to work', 'verb', null, null, 'A1', 23, 'work', 'Ich muss morgen bis sechs arbeiten.', 'I have to work until six tomorrow.', null),
  (24, 'wohnen', 'to live (somewhere)', 'verb', null, null, 'A1', 24, 'home', 'Ich möchte in der Nähe vom Bahnhof wohnen.', 'I''d like to live near the station.', 'wohnen = where you live; leben = to be alive / your life in general.'),
  (25, 'essen', 'to eat', 'verb', null, null, 'A1', 25, 'food', 'Wollen wir heute zusammen essen?', 'Shall we eat together today?', 'du isst, er isst.'),
  (26, 'trinken', 'to drink', 'verb', null, null, 'A1', 26, 'food', 'Möchtest du etwas trinken?', 'Would you like something to drink?', null),
  (27, 'kaufen', 'to buy', 'verb', null, null, 'A1', 27, 'shopping', 'Ich muss noch Brot kaufen.', 'I still need to buy bread.', null),
  (28, 'Zug', 'train', 'noun', 'der', 'Züge', 'A1', 28, 'transport', 'Der Zug hat zehn Minuten Verspätung.', 'The train is ten minutes late.', null),
  (29, 'Tag', 'day', 'noun', 'der', 'Tage', 'A1', 29, 'time', 'Ich wünsche dir einen schönen Tag!', 'Have a nice day!', null),
  (30, 'können', 'can, to be able to', 'verb', null, null, 'A1', 30, 'everyday', 'Kannst du mir kurz helfen?', 'Can you help me for a moment?', 'ich kann, du kannst, er kann. The second verb goes to the end.'),
  (31, 'müssen', 'must, to have to', 'verb', null, null, 'A1', 31, 'everyday', 'Ich muss heute länger arbeiten.', 'I have to work late today.', 'ich muss, du musst, er muss.'),
  (32, 'möchten', 'would like', 'verb', null, null, 'A1', 32, 'food', 'Ich möchte einen Kaffee, bitte.', 'I''d like a coffee, please.', 'The polite way to ask for things: ich möchte, du möchtest.'),
  (33, 'helfen', 'to help', 'verb', null, null, 'A1', 33, 'everyday', 'Kannst du mir bitte helfen?', 'Can you help me, please?', 'helfen + Dativ: Ich helfe dir (not dich).'),
  (34, 'verstehen', 'to understand', 'verb', null, null, 'A1', 34, 'communication', 'Ich kann dich leider nicht verstehen.', 'Sorry, I can''t understand you.', null),
  (35, 'sprechen', 'to speak', 'verb', null, null, 'A1', 35, 'communication', 'Können Sie bitte langsamer sprechen?', 'Could you speak more slowly, please?', 'du sprichst, er spricht.'),
  (36, 'Zimmer', 'room', 'noun', 'das', 'Zimmer', 'A1', 36, 'home', 'Mein Zimmer ist klein, aber gemütlich.', 'My room is small but cosy.', null),
  (37, 'Supermarkt', 'supermarket', 'noun', 'der', 'Supermärkte', 'A1', 37, 'shopping', 'Der Supermarkt hat bis zehn Uhr offen.', 'The supermarket is open until ten.', null),
  (38, 'Kaffee', 'coffee', 'noun', 'der', null, 'A1', 38, 'food', 'Trinken wir einen Kaffee zusammen?', 'Shall we have a coffee together?', null),
  (39, 'Freund', 'friend; boyfriend', 'noun', 'der', 'Freunde', 'A1', 39, 'people', 'Am Wochenende besuche ich einen Freund.', 'At the weekend I''m visiting a friend.', 'A female friend: die Freundin.'),
  (40, 'Woche', 'week', 'noun', 'die', 'Wochen', 'A1', 40, 'time', 'Nächste Woche habe ich Urlaub.', 'I''m on holiday next week.', null),
  (41, 'morgen', 'tomorrow', 'adverb', null, null, 'A1', 41, 'time', 'Morgen fahre ich nach Köln.', 'Tomorrow I''m going to Cologne.', 'Lower case morgen = tomorrow; der Morgen = the morning.'),
  (42, 'jetzt', 'now', 'adverb', null, null, 'A1', 42, 'time', 'Ich habe jetzt leider keine Zeit.', 'Unfortunately I don''t have time right now.', null),
  (43, 'mit', 'with', 'preposition', null, null, 'A1', 43, 'everyday', 'Ich fahre mit dem Bus zur Arbeit.', 'I take the bus to work.', 'mit + Dativ: mit dem Bus, mit der Bahn.'),
  (44, 'Bus', 'bus', 'noun', 'der', 'Busse', 'A1', 44, 'transport', 'Der Bus kommt alle zehn Minuten.', 'The bus comes every ten minutes.', null),
  (45, 'brauchen', 'to need', 'verb', null, null, 'A1', 45, 'everyday', 'Wir werden mehr Zeit brauchen.', 'We''re going to need more time.', null),
  (46, 'teuer', 'expensive', 'adjective', null, null, 'A1', 46, 'shopping', 'Das Hotel ist mir zu teuer.', 'The hotel is too expensive for me.', null),
  (47, 'Wie geht''s?', 'how are you?', 'phrase', null, null, 'A1', 47, 'communication', 'Hallo Anna, wie geht''s?', 'Hi Anna, how are you?', 'Formal: Wie geht es Ihnen?'),
  (48, 'Rechnung', 'bill, invoice', 'noun', 'die', 'Rechnungen', 'A1', 48, 'shopping', 'Die Rechnung, bitte!', 'The bill, please!', null),
  (49, 'Kind', 'child', 'noun', 'das', 'Kinder', 'A1', 49, 'people', 'Unser Kind geht schon in die Schule.', 'Our child already goes to school.', null),
  (50, 'Schlüssel', 'key', 'noun', 'der', 'Schlüssel', 'A1', 50, 'home', 'Ich finde meinen Schlüssel nicht.', 'I can''t find my key.', null),
  (51, 'Büro', 'office', 'noun', 'das', 'Büros', 'A1', 51, 'work', 'Ich bin bis fünf im Büro.', 'I''m in the office until five.', null),
  (52, 'Uhr', 'clock, watch; o''clock', 'noun', 'die', 'Uhren', 'A1', 52, 'time', 'Wir treffen uns um acht Uhr.', 'We''re meeting at eight o''clock.', null),
  (53, 'Fahrkarte', 'ticket (for bus or train)', 'noun', 'die', 'Fahrkarten', 'A1', 53, 'transport', 'Ich brauche eine Fahrkarte nach Berlin.', 'I need a ticket to Berlin.', null),
  (54, 'wissen', 'to know (a fact)', 'verb', null, null, 'A1', 54, 'communication', 'Ich will wissen, wann der Zug kommt.', 'I want to know when the train is coming.', 'ich weiß, du weißt, er weiß. For people and places use kennen.'),
  (55, 'kennen', 'to know (a person or place)', 'verb', null, null, 'A1', 55, 'people', 'Du musst den Film kennen, er ist sehr bekannt.', 'You must know the film, it''s very famous.', 'kennen = be familiar with; wissen = know a fact.'),
  (56, 'fragen', 'to ask', 'verb', null, null, 'A1', 56, 'communication', 'Du kannst mich immer fragen.', 'You can always ask me.', null),
  (57, 'sagen', 'to say, to tell', 'verb', null, null, 'A1', 57, 'communication', 'Kannst du mir sagen, wie spät es ist?', 'Can you tell me what time it is?', null),
  (58, 'bezahlen', 'to pay', 'verb', null, null, 'A1', 58, 'shopping', 'Kann ich mit Karte bezahlen?', 'Can I pay by card?', null),
  (59, 'anrufen', 'to call (on the phone)', 'verb', null, null, 'A1', 59, 'communication', 'Ich muss meine Mutter anrufen.', 'I have to call my mother.', 'Separable: Ich rufe dich morgen an.'),
  (60, 'aufstehen', 'to get up', 'verb', null, null, 'A1', 60, 'everyday', 'Ich muss morgen früh aufstehen.', 'I have to get up early tomorrow.', 'Separable: Ich stehe um sechs auf.'),
  (61, 'einkaufen', 'to go shopping', 'verb', null, null, 'A1', 61, 'shopping', 'Ich muss nach der Arbeit noch einkaufen.', 'I still have to go shopping after work.', 'Separable: Ich kaufe heute ein.'),
  (62, 'schlecht', 'bad', 'adjective', null, null, 'A1', 62, 'everyday', 'Das Wetter ist heute schlecht.', 'The weather is bad today.', null),
  (63, 'groß', 'big, tall', 'adjective', null, null, 'A1', 63, 'everyday', 'Die Wohnung ist groß und hell.', 'The flat is big and bright.', null),
  (64, 'klein', 'small, little', 'adjective', null, null, 'A1', 64, 'everyday', 'Das Zimmer ist leider sehr klein.', 'Unfortunately the room is very small.', null),
  (65, 'neu', 'new', 'adjective', null, null, 'A1', 65, 'everyday', 'Mein Handy ist ganz neu.', 'My phone is brand new.', null),
  (66, 'alt', 'old', 'adjective', null, null, 'A1', 66, 'everyday', 'Das Haus ist schon sehr alt.', 'The house is already very old.', null),
  (67, 'müde', 'tired', 'adjective', null, null, 'A1', 67, 'everyday', 'Ich bin heute sehr müde.', 'I''m very tired today.', null),
  (68, 'krank', 'ill, sick', 'adjective', null, null, 'A1', 68, 'appointments', 'Ich bin krank und bleibe heute zu Hause.', 'I''m ill and staying at home today.', null),
  (69, 'Tschüss', 'bye', 'phrase', null, null, 'A1', 69, 'communication', 'Tschüss, bis morgen!', 'Bye, see you tomorrow!', null),
  (70, 'Wasser', 'water', 'noun', 'das', null, 'A1', 70, 'food', 'Kann ich bitte ein Glas Wasser haben?', 'Can I have a glass of water, please?', null),
  (71, 'Frühstück', 'breakfast', 'noun', 'das', null, 'A1', 71, 'food', 'Das Frühstück ist um acht.', 'Breakfast is at eight.', null),
  (72, 'Kollege', 'colleague', 'noun', 'der', 'Kollegen', 'A1', 72, 'work', 'Mein Kollege hilft mir oft.', 'My colleague often helps me.', 'A female colleague: die Kollegin.'),
  (73, 'Straße', 'street, road', 'noun', 'die', 'Straßen', 'A1', 73, 'transport', 'Wir wohnen in einer ruhigen Straße.', 'We live on a quiet street.', null),
  (74, 'Frau', 'woman; wife; Mrs', 'noun', 'die', 'Frauen', 'A1', 74, 'people', 'Die Frau am Empfang ist sehr freundlich.', 'The woman at reception is very friendly.', null),
  (75, 'Name', 'name', 'noun', 'der', 'Namen', 'A1', 75, 'people', 'Wie ist Ihr Name, bitte?', 'What''s your name, please?', null),
  (76, 'Hotel', 'hotel', 'noun', 'das', 'Hotels', 'A1', 76, 'travel', 'Das Hotel liegt direkt am Bahnhof.', 'The hotel is right by the station.', null),
  (77, 'Stadt', 'city, town', 'noun', 'die', 'Städte', 'A1', 77, 'travel', 'Die Stadt ist am Wochenende sehr voll.', 'The city is very crowded at the weekend.', null),
  (78, 'Auto', 'car', 'noun', 'das', 'Autos', 'A1', 78, 'transport', 'Wir fahren mit dem Auto in den Urlaub.', 'We''re driving on holiday.', null),
  (79, 'E-Mail', 'email', 'noun', 'die', 'E-Mails', 'A1', 79, 'communication', 'Ich schreibe dir später eine E-Mail.', 'I''ll write you an email later.', null),
  (80, 'Chef', 'boss', 'noun', 'der', 'Chefs', 'A1', 80, 'work', 'Der Chef ist heute nicht im Büro.', 'The boss isn''t in the office today.', 'A female boss: die Chefin. A chef (cook) is der Koch.'),
  (81, 'Abend', 'evening', 'noun', 'der', 'Abende', 'A1', 81, 'time', 'Am Abend sehe ich gern fern.', 'In the evening I like watching TV.', null),
  (82, 'Jahr', 'year', 'noun', 'das', 'Jahre', 'A1', 82, 'time', 'Ich lerne seit einem Jahr Deutsch.', 'I''ve been learning German for a year.', null),
  (83, 'Tür', 'door', 'noun', 'die', 'Türen', 'A1', 83, 'home', 'Kannst du bitte die Tür zumachen?', 'Could you close the door, please?', null),
  (84, 'Preis', 'price', 'noun', 'der', 'Preise', 'A1', 84, 'shopping', 'Der Preis ist mir zu hoch.', 'The price is too high for me.', null),
  (85, 'Abendessen', 'dinner, evening meal', 'noun', 'das', 'Abendessen', 'A1', 85, 'food', 'Was gibt es heute zum Abendessen?', 'What''s for dinner tonight?', null),
  (86, 'Küche', 'kitchen', 'noun', 'die', 'Küchen', 'A1', 86, 'home', 'Die Küche ist klein, aber praktisch.', 'The kitchen is small but practical.', null),
  (87, 'lernen', 'to learn, to study', 'verb', null, null, 'A1', 87, 'everyday', 'Ich möchte jeden Tag ein bisschen Deutsch lernen.', 'I''d like to learn a little German every day.', null),
  (88, 'schreiben', 'to write', 'verb', null, null, 'A1', 88, 'communication', 'Kannst du mir die Adresse schreiben?', 'Can you write down the address for me?', null),
  (89, 'lesen', 'to read', 'verb', null, null, 'A1', 89, 'everyday', 'Ich muss die E-Mail noch lesen.', 'I still have to read the email.', 'du liest, er liest.'),
  (90, 'sehen', 'to see', 'verb', null, null, 'A1', 90, 'everyday', 'Kann ich mal die Fotos sehen?', 'Can I have a look at the photos?', 'du siehst, er sieht.'),
  (91, 'schlafen', 'to sleep', 'verb', null, null, 'A1', 91, 'home', 'Am Sonntag will ich lange schlafen.', 'On Sunday I want to sleep in.', null),
  (92, 'wollen', 'to want', 'verb', null, null, 'A1', 92, 'everyday', 'Wir wollen am Samstag ins Kino.', 'We want to go to the cinema on Saturday.', 'ich will, du willst, er will. Not ''will'' as in English future!'),
  (93, 'bleiben', 'to stay', 'verb', null, null, 'A1', 93, 'everyday', 'Kannst du heute länger bleiben?', 'Can you stay longer today?', null),
  (94, 'bringen', 'to bring', 'verb', null, null, 'A1', 94, 'food', 'Können Sie mir bitte noch ein Glas Wasser bringen?', 'Could you bring me another glass of water, please?', null),
  (95, 'geben', 'to give', 'verb', null, null, 'A1', 95, 'everyday', 'Kannst du mir das Salz geben?', 'Can you pass me the salt?', 'jemandem (Dativ) etwas (Akkusativ) geben. es gibt = there is.'),
  (96, 'nehmen', 'to take', 'verb', null, null, 'A1', 96, 'transport', 'Wir können den Bus um acht nehmen.', 'We can take the bus at eight.', 'du nimmst, er nimmt.'),
  (97, 'treffen', 'to meet', 'verb', null, null, 'A1', 97, 'people', 'Wollen wir uns morgen treffen?', 'Shall we meet tomorrow?', 'sich treffen = to meet up (with each other).'),
  (98, 'suchen', 'to look for, to search', 'verb', null, null, 'A1', 98, 'everyday', 'Kannst du mir helfen, meinen Schlüssel zu suchen?', 'Can you help me look for my key?', null),
  (99, 'finden', 'to find; to think (opinion)', 'verb', null, null, 'A1', 99, 'everyday', 'Ich kann mein Handy nicht finden.', 'I can''t find my phone.', 'Ich finde das gut = I think that''s good.'),
  (100, 'öffnen', 'to open', 'verb', null, null, 'A1', 100, 'home', 'Kannst du bitte das Fenster öffnen?', 'Could you open the window, please?', null),
  (101, 'billig', 'cheap', 'adjective', null, null, 'A1', 101, 'shopping', 'Das T-Shirt war richtig billig.', 'The T-shirt was really cheap.', null),
  (102, 'schnell', 'fast, quick', 'adjective', null, null, 'A1', 102, 'transport', 'Der Zug ist sehr schnell.', 'The train is very fast.', null),
  (103, 'langsam', 'slow', 'adjective', null, null, 'A1', 103, 'transport', 'Der Bus ist heute so langsam.', 'The bus is so slow today.', null),
  (104, 'schön', 'beautiful, nice', 'adjective', null, null, 'A1', 104, 'everyday', 'Das Wetter ist heute schön.', 'The weather is nice today.', null),
  (105, 'lecker', 'tasty, delicious', 'adjective', null, null, 'A1', 105, 'food', 'Der Kuchen ist echt lecker!', 'The cake is really delicious!', null),
  (106, 'frei', 'free, available', 'adjective', null, null, 'A1', 106, 'everyday', 'Ist der Platz hier frei?', 'Is this seat free?', null),
  (107, 'wichtig', 'important', 'adjective', null, null, 'A1', 107, 'work', 'Der Termin ist sehr wichtig.', 'The appointment is very important.', null),
  (108, 'richtig', 'right, correct', 'adjective', null, null, 'A1', 108, 'communication', 'Ist die Adresse richtig?', 'Is the address correct?', null),
  (109, 'falsch', 'wrong', 'adjective', null, null, 'A1', 109, 'communication', 'Die Nummer ist falsch.', 'The number is wrong.', null),
  (110, 'kalt', 'cold', 'adjective', null, null, 'A1', 110, 'everyday', 'Der Kaffee ist schon kalt.', 'The coffee has already gone cold.', null),
  (111, 'gestern', 'yesterday', 'adverb', null, null, 'A1', 111, 'time', 'Gestern war ich beim Arzt.', 'Yesterday I was at the doctor''s.', null),
  (112, 'später', 'later', 'adverb', null, null, 'A1', 112, 'time', 'Ich rufe dich später an.', 'I''ll call you later.', null),
  (113, 'immer', 'always', 'adverb', null, null, 'A1', 113, 'time', 'Der Bus ist immer pünktlich.', 'The bus is always on time.', null),
  (114, 'oft', 'often', 'adverb', null, null, 'A1', 114, 'time', 'Wir gehen oft zusammen essen.', 'We often go out to eat together.', null),
  (115, 'manchmal', 'sometimes', 'adverb', null, null, 'A1', 115, 'time', 'Manchmal arbeite ich von zu Hause.', 'Sometimes I work from home.', null),
  (116, 'nie', 'never', 'adverb', null, null, 'A1', 116, 'time', 'Abends trinke ich nie Kaffee.', 'I never drink coffee in the evening.', null),
  (117, 'hier', 'here', 'adverb', null, null, 'A1', 117, 'everyday', 'Wohnen Sie hier?', 'Do you live here?', null),
  (118, 'dort', 'there', 'adverb', null, null, 'A1', 118, 'everyday', 'Dort drüben ist der Bahnhof.', 'The station is over there.', null),
  (119, 'sehr', 'very', 'adverb', null, null, 'A1', 119, 'everyday', 'Vielen Dank, das ist sehr nett.', 'Thank you, that''s very kind.', null),
  (120, 'auch', 'also, too', 'adverb', null, null, 'A1', 120, 'everyday', 'Ich komme auch mit.', 'I''m coming too.', null),
  (121, 'schon', 'already', 'adverb', null, null, 'A1', 121, 'time', 'Bist du schon fertig?', 'Are you finished already?', null),
  (122, 'noch', 'still; yet', 'adverb', null, null, 'A1', 122, 'time', 'Ich bin noch im Büro.', 'I''m still at the office.', null),
  (123, 'zusammen', 'together', 'adverb', null, null, 'A1', 123, 'people', 'Wir wohnen seit zwei Jahren zusammen.', 'We''ve been living together for two years.', null),
  (124, 'gern', 'gladly (Ich koche gern = I like cooking)', 'adverb', null, null, 'A1', 124, 'everyday', 'Ich koche gern für Freunde.', 'I like cooking for friends.', 'verb + gern = like doing something.'),
  (125, 'leider', 'unfortunately', 'adverb', null, null, 'A1', 125, 'communication', 'Ich kann leider nicht kommen.', 'Unfortunately I can''t come.', null),
  (126, 'vielleicht', 'maybe, perhaps', 'adverb', null, null, 'A1', 126, 'communication', 'Vielleicht komme ich später.', 'Maybe I''ll come later.', null),
  (127, 'ohne', 'without', 'preposition', null, null, 'A1', 127, 'everyday', 'Ich trinke Kaffee ohne Zucker.', 'I drink coffee without sugar.', 'ohne + Akkusativ.'),
  (128, 'für', 'for', 'preposition', null, null, 'A1', 128, 'everyday', 'Das Geschenk ist für dich.', 'The present is for you.', 'für + Akkusativ: für dich, für meinen Bruder.'),
  (129, 'nach', 'after; to (cities, countries, home)', 'preposition', null, null, 'A1', 129, 'time', 'Nach der Arbeit gehe ich einkaufen.', 'After work I''m going shopping.', 'nach + Dativ. nach Berlin, nach Hause.'),
  (130, 'bei', 'at (someone''s place or company)', 'preposition', null, null, 'A1', 130, 'people', 'Ich bin heute Abend bei meinen Eltern.', 'I''m at my parents'' this evening.', 'bei + Dativ: beim Arzt = bei dem Arzt.'),
  (131, 'zu', 'to (a person or place)', 'preposition', null, null, 'A1', 131, 'everyday', 'Ich gehe morgen zu meiner Oma.', 'I''m going to my grandma''s tomorrow.', 'zu + Dativ: zum = zu dem, zur = zu der.'),
  (132, 'aus', 'from (origin), out of', 'preposition', null, null, 'A1', 132, 'people', 'Ich komme aus Polen.', 'I''m from Poland.', 'aus + Dativ.'),
  (133, 'von', 'from (a person or starting point); of', 'preposition', null, null, 'A1', 133, 'everyday', 'Das ist ein Geschenk von meiner Mutter.', 'That''s a present from my mother.', 'von + Dativ: vom = von dem.'),
  (134, 'aber', 'but', 'conjunction', null, null, 'A1', 134, 'communication', 'Ich bin müde, aber ich muss noch arbeiten.', 'I''m tired, but I still have to work.', null),
  (135, 'oder', 'or', 'conjunction', null, null, 'A1', 135, 'communication', 'Möchtest du Tee oder Kaffee?', 'Would you like tea or coffee?', null),
  (136, 'Guten Morgen', 'good morning', 'phrase', null, null, 'A1', 136, 'communication', 'Guten Morgen! Hast du gut geschlafen?', 'Good morning! Did you sleep well?', null),
  (137, 'Bis später', 'see you later', 'phrase', null, null, 'A1', 137, 'communication', 'Ich muss los. Bis später!', 'I have to go. See you later!', null),
  (138, 'Keine Ahnung', 'no idea', 'phrase', null, null, 'A1', 138, 'communication', 'Wo ist Tom? – Keine Ahnung.', 'Where''s Tom? – No idea.', null),
  (139, 'Wie bitte?', 'pardon? (I didn''t catch that)', 'phrase', null, null, 'A1', 139, 'communication', 'Wie bitte? Können Sie das wiederholen?', 'Pardon? Could you repeat that?', null),
  (140, 'Kein Problem', 'no problem', 'phrase', null, null, 'A1', 140, 'communication', 'Danke! – Kein Problem.', 'Thanks! – No problem.', null),
  (141, 'Guten Appetit', 'enjoy your meal', 'phrase', null, null, 'A1', 141, 'food', 'Das Essen ist fertig. Guten Appetit!', 'Dinner''s ready. Enjoy your meal!', null),
  (142, 'Ich hätte gern', 'I''d like (when ordering)', 'phrase', null, null, 'A1', 142, 'shopping', 'Ich hätte gern ein Stück Kuchen.', 'I''d like a piece of cake.', null),
  (143, 'Alles klar', 'all right, got it', 'phrase', null, null, 'A1', 143, 'communication', 'Alles klar, bis morgen!', 'All right, see you tomorrow!', null),
  (1001, 'sich erinnern', 'to remember', 'verb', null, null, 'A2', 1, 'communication', 'Ich kann mich nicht an seinen Namen erinnern.', 'I can''t remember his name.', 'sich erinnern an + Akkusativ: Erinnerst du dich an mich?'),
  (1002, 'vereinbaren', 'to arrange (an appointment)', 'verb', null, null, 'A2', 2, 'appointments', 'Ich möchte einen Termin vereinbaren.', 'I''d like to make an appointment.', null),
  (1003, 'absagen', 'to cancel', 'verb', null, null, 'A2', 3, 'appointments', 'Ich muss den Termin leider absagen.', 'Unfortunately I have to cancel the appointment.', 'Separable: Ich sage den Termin ab.'),
  (1004, 'verschieben', 'to postpone, to reschedule', 'verb', null, null, 'A2', 4, 'appointments', 'Können wir die Besprechung auf Freitag verschieben?', 'Can we move the meeting to Friday?', null),
  (1005, 'Besprechung', 'meeting (at work)', 'noun', 'die', 'Besprechungen', 'A2', 5, 'work', 'Die Besprechung dauert bis zwölf.', 'The meeting lasts until twelve.', null),
  (1006, 'Miete', 'rent', 'noun', 'die', 'Mieten', 'A2', 6, 'home', 'Die Miete ist in Berlin ziemlich hoch.', 'Rent in Berlin is pretty high.', null),
  (1007, 'Apotheke', 'pharmacy', 'noun', 'die', 'Apotheken', 'A2', 7, 'appointments', 'Die Apotheke ist gleich um die Ecke.', 'The pharmacy is just around the corner.', null),
  (1008, 'Verspätung', 'delay', 'noun', 'die', 'Verspätungen', 'A2', 8, 'transport', 'Der Flug hat zwei Stunden Verspätung.', 'The flight is two hours late.', null),
  (1009, 'Haltestelle', 'stop (bus or tram)', 'noun', 'die', 'Haltestellen', 'A2', 9, 'transport', 'Die Haltestelle ist direkt vor dem Haus.', 'The stop is right in front of the house.', null),
  (1010, 'Flughafen', 'airport', 'noun', 'der', 'Flughäfen', 'A2', 10, 'travel', 'Wie komme ich am besten zum Flughafen?', 'What''s the best way to get to the airport?', null),
  (1011, 'Ausweis', 'ID card', 'noun', 'der', 'Ausweise', 'A2', 11, 'travel', 'Haben Sie Ihren Ausweis dabei?', 'Do you have your ID with you?', null),
  (1012, 'Formular', 'form (document)', 'noun', 'das', 'Formulare', 'A2', 12, 'appointments', 'Bitte füllen Sie dieses Formular aus.', 'Please fill in this form.', null),
  (1013, 'ausfüllen', 'to fill in, to fill out', 'verb', null, null, 'A2', 13, 'appointments', 'Sie müssen nur noch das Formular ausfüllen.', 'You just need to fill in the form.', null),
  (1014, 'unterschreiben', 'to sign', 'verb', null, null, 'A2', 14, 'work', 'Sie müssen hier unten unterschreiben.', 'You need to sign down here.', 'Not separable: Ich unterschreibe.'),
  (1015, 'umsteigen', 'to change (trains, buses)', 'verb', null, null, 'A2', 15, 'transport', 'In Frankfurt müssen Sie umsteigen.', 'You have to change in Frankfurt.', null),
  (1016, 'Nachricht', 'message; (die Nachrichten) the news', 'noun', 'die', 'Nachrichten', 'A2', 16, 'communication', 'Ich schicke dir gleich eine Nachricht.', 'I''ll send you a message right away.', null),
  (1017, 'Erkältung', 'cold (illness)', 'noun', 'die', 'Erkältungen', 'A2', 17, 'appointments', 'Ich habe eine schlimme Erkältung.', 'I''ve got a bad cold.', null),
  (1018, 'Einladung', 'invitation', 'noun', 'die', 'Einladungen', 'A2', 18, 'people', 'Danke für die Einladung!', 'Thanks for the invitation!', null),
  (1019, 'Geschenk', 'present, gift', 'noun', 'das', 'Geschenke', 'A2', 19, 'people', 'Ich brauche noch ein Geschenk für meinen Bruder.', 'I still need a present for my brother.', null),
  (1020, 'Nachbar', 'neighbour', 'noun', 'der', 'Nachbarn', 'A2', 20, 'home', 'Unser Nachbar ist sehr hilfsbereit.', 'Our neighbour is very helpful.', 'A female neighbour: die Nachbarin.'),
  (1021, 'Angebot', 'offer; special offer', 'noun', 'das', 'Angebote', 'A2', 21, 'shopping', 'Der Käse ist diese Woche im Angebot.', 'The cheese is on special offer this week.', null),
  (1022, 'Quittung', 'receipt', 'noun', 'die', 'Quittungen', 'A2', 22, 'shopping', 'Kann ich bitte eine Quittung bekommen?', 'Can I get a receipt, please?', null),
  (1023, 'Größe', 'size', 'noun', 'die', 'Größen', 'A2', 23, 'shopping', 'Haben Sie die Jacke auch in Größe M?', 'Do you have the jacket in size M too?', null),
  (1024, 'Erfahrung', 'experience', 'noun', 'die', 'Erfahrungen', 'A2', 24, 'work', 'Ich habe viel Erfahrung im Verkauf.', 'I have a lot of experience in sales.', null),
  (1025, 'Bewerbung', '(job) application', 'noun', 'die', 'Bewerbungen', 'A2', 25, 'work', 'Ich schreibe gerade eine Bewerbung.', 'I''m writing a job application at the moment.', null),
  (1026, 'Vertrag', 'contract', 'noun', 'der', 'Verträge', 'A2', 26, 'work', 'Der Vertrag läuft zwei Jahre.', 'The contract runs for two years.', null),
  (1027, 'Abfahrt', 'departure', 'noun', 'die', 'Abfahrten', 'A2', 27, 'travel', 'Die Abfahrt ist um 7:15 Uhr.', 'Departure is at 7:15.', null),
  (1028, 'Ankunft', 'arrival', 'noun', 'die', 'Ankünfte', 'A2', 28, 'travel', 'Nach der Ankunft rufe ich dich an.', 'I''ll call you after I arrive.', null),
  (1029, 'Unterkunft', 'accommodation, place to stay', 'noun', 'die', 'Unterkünfte', 'A2', 29, 'travel', 'Wir suchen noch eine Unterkunft für drei Nächte.', 'We''re still looking for somewhere to stay for three nights.', null),
  (1030, 'Gleis', 'platform, track', 'noun', 'das', 'Gleise', 'A2', 30, 'transport', 'Der Zug fährt heute von Gleis 5.', 'Today the train leaves from platform 5.', null),
  (1031, 'Rezept', 'prescription; recipe', 'noun', 'das', 'Rezepte', 'A2', 31, 'appointments', 'Für das Medikament brauchen Sie ein Rezept.', 'You need a prescription for this medicine.', null),
  (1032, 'Problem', 'problem', 'noun', 'das', 'Probleme', 'A2', 32, 'everyday', 'Wir haben ein kleines Problem mit der Heizung.', 'We have a small problem with the heating.', null),
  (1033, 'Lösung', 'solution', 'noun', 'die', 'Lösungen', 'A2', 33, 'work', 'Wir finden bestimmt eine Lösung.', 'I''m sure we''ll find a solution.', null),
  (1034, 'Versicherung', 'insurance', 'noun', 'die', 'Versicherungen', 'A2', 34, 'appointments', 'Die Versicherung bezahlt den Schaden.', 'The insurance pays for the damage.', null),
  (1035, 'Vermieter', 'landlord', 'noun', 'der', 'Vermieter', 'A2', 35, 'home', 'Ich muss den Vermieter wegen der Heizung anrufen.', 'I have to call the landlord about the heating.', 'A landlady: die Vermieterin.'),
  (1036, 'sich bewerben', 'to apply (for a job)', 'verb', null, null, 'A2', 36, 'work', 'Ich will mich um die Stelle bewerben.', 'I want to apply for the job.', 'sich bewerben um / bei: Ich bewerbe mich bei Siemens.'),
  (1037, 'sich beschweren', 'to complain', 'verb', null, null, 'A2', 37, 'shopping', 'Ich möchte mich beschweren.', 'I''d like to make a complaint.', 'sich beschweren über + Akkusativ.'),
  (1038, 'leihen', 'to lend; to borrow', 'verb', null, null, 'A2', 38, 'everyday', 'Kannst du mir dein Fahrrad leihen?', 'Can you lend me your bike?', 'jemandem etwas leihen = lend; sich etwas leihen = borrow.'),
  (1039, 'mieten', 'to rent (as a tenant or customer)', 'verb', null, null, 'A2', 39, 'travel', 'Im Urlaub wollen wir ein Auto mieten.', 'We want to rent a car on holiday.', null),
  (1040, 'vergessen', 'to forget', 'verb', null, null, 'A2', 40, 'everyday', 'Ich darf den Termin nicht vergessen.', 'I mustn''t forget the appointment.', null),
  (1041, 'erklären', 'to explain', 'verb', null, null, 'A2', 41, 'communication', 'Kannst du mir das noch einmal erklären?', 'Can you explain that to me again?', null),
  (1042, 'benutzen', 'to use', 'verb', null, null, 'A2', 42, 'everyday', 'Darf ich kurz dein Handy benutzen?', 'May I use your phone for a moment?', null),
  (1043, 'reparieren', 'to repair, to fix', 'verb', null, null, 'A2', 43, 'home', 'Kannst du mein Fahrrad reparieren?', 'Can you fix my bike?', null),
  (1044, 'versuchen', 'to try', 'verb', null, null, 'A2', 44, 'everyday', 'Ich will es noch einmal versuchen.', 'I want to try again.', null),
  (1045, 'sich kümmern', 'to take care of, to look after', 'verb', null, null, 'A2', 45, 'people', 'Ich muss mich heute um die Kinder kümmern.', 'I have to look after the kids today.', 'sich kümmern um + Akkusativ.'),
  (1046, 'gefallen', 'to please (Es gefällt mir = I like it)', 'verb', null, null, 'A2', 46, 'everyday', 'Die Wohnung wird dir bestimmt gefallen.', 'I''m sure you''ll like the flat.', 'gefallen + Dativ: The thing is the subject. Der Film gefällt mir.'),
  (1047, 'gehören', 'to belong to', 'verb', null, null, 'A2', 47, 'everyday', 'Wem gehört der Schlüssel?', 'Whose key is this?', 'gehören + Dativ: Das gehört mir.'),
  (1048, 'danken', 'to thank', 'verb', null, null, 'A2', 48, 'communication', 'Ich möchte dir für alles danken.', 'I''d like to thank you for everything.', 'danken + Dativ: Ich danke dir.'),
  (1049, 'empfehlen', 'to recommend', 'verb', null, null, 'A2', 49, 'food', 'Können Sie mir ein Restaurant empfehlen?', 'Can you recommend a restaurant?', 'du empfiehlst, er empfiehlt.'),
  (1050, 'bestellen', 'to order', 'verb', null, null, 'A2', 50, 'food', 'Wollen wir eine Pizza bestellen?', 'Shall we order a pizza?', null),
  (1051, 'abholen', 'to pick up, to collect', 'verb', null, null, 'A2', 51, 'transport', 'Kannst du mich vom Bahnhof abholen?', 'Can you pick me up from the station?', null),
  (1052, 'mitbringen', 'to bring along', 'verb', null, null, 'A2', 52, 'people', 'Soll ich etwas zu trinken mitbringen?', 'Shall I bring something to drink?', null),
  (1053, 'sich entscheiden', 'to decide', 'verb', null, null, 'A2', 53, 'everyday', 'Ich kann mich einfach nicht entscheiden.', 'I just can''t decide.', null),
  (1054, 'warten', 'to wait', 'verb', null, null, 'A2', 54, 'transport', 'Wir müssen noch auf den Bus warten.', 'We still have to wait for the bus.', 'warten auf + Akkusativ.'),
  (1055, 'sich freuen', 'to look forward to; to be pleased', 'verb', null, null, 'A2', 55, 'people', 'Ich freue mich auf das Wochenende.', 'I''m looking forward to the weekend.', 'sich freuen auf (future) / über (now).'),
  (1056, 'pünktlich', 'punctual, on time', 'adjective', null, null, 'A2', 56, 'appointments', 'Bitte sei morgen pünktlich.', 'Please be on time tomorrow.', null),
  (1057, 'dringend', 'urgent', 'adjective', null, null, 'A2', 57, 'work', 'Es ist wirklich dringend.', 'It''s really urgent.', null),
  (1058, 'möglich', 'possible', 'adjective', null, null, 'A2', 58, 'appointments', 'Ist ein Termin am Montag möglich?', 'Is an appointment on Monday possible?', null),
  (1059, 'zufrieden', 'satisfied, content', 'adjective', null, null, 'A2', 59, 'everyday', 'Bist du mit der neuen Wohnung zufrieden?', 'Are you happy with the new flat?', null),
  (1060, 'erkältet', 'having a cold', 'adjective', null, null, 'A2', 60, 'appointments', 'Ich bin leider erkältet.', 'Unfortunately I''ve got a cold.', null),
  (1061, 'nervös', 'nervous', 'adjective', null, null, 'A2', 61, 'work', 'Vor dem Vorstellungsgespräch bin ich immer nervös.', 'I''m always nervous before a job interview.', null),
  (1062, 'gemütlich', 'cosy, comfortable', 'adjective', null, null, 'A2', 62, 'home', 'Das Café ist richtig gemütlich.', 'The café is really cosy.', null),
  (1063, 'ruhig', 'quiet, calm', 'adjective', null, null, 'A2', 63, 'home', 'Unsere Straße ist sehr ruhig.', 'Our street is very quiet.', null),
  (1064, 'voll', 'full; crowded', 'adjective', null, null, 'A2', 64, 'transport', 'Der Zug ist total voll.', 'The train is completely packed.', null),
  (1065, 'leer', 'empty; dead (battery)', 'adjective', null, null, 'A2', 65, 'everyday', 'Der Kühlschrank ist leer.', 'The fridge is empty.', null),
  (1066, 'geöffnet', 'open (shops, offices)', 'adjective', null, null, 'A2', 66, 'shopping', 'Die Apotheke ist bis 20 Uhr geöffnet.', 'The pharmacy is open until 8 pm.', null),
  (1067, 'sofort', 'immediately, right away', 'adverb', null, null, 'A2', 67, 'time', 'Ich komme sofort!', 'I''m coming right away!', null),
  (1068, 'ungefähr', 'about, approximately', 'adverb', null, null, 'A2', 68, 'time', 'Die Fahrt dauert ungefähr eine Stunde.', 'The journey takes about an hour.', null),
  (1069, 'eigentlich', 'actually', 'adverb', null, null, 'A2', 69, 'communication', 'Eigentlich habe ich heute keine Zeit.', 'Actually, I don''t have time today.', null),
  (1070, 'trotzdem', 'nevertheless, still', 'adverb', null, null, 'A2', 70, 'communication', 'Es regnet, aber wir gehen trotzdem spazieren.', 'It''s raining, but we''re still going for a walk.', null),
  (1071, 'unterwegs', 'on the way, out and about', 'adverb', null, null, 'A2', 71, 'transport', 'Ich bin gerade unterwegs.', 'I''m out at the moment.', null),
  (1072, 'vorher', 'beforehand', 'adverb', null, null, 'A2', 72, 'time', 'Ruf mich bitte vorher an.', 'Please call me beforehand.', null),
  (1073, 'danach', 'afterwards', 'adverb', null, null, 'A2', 73, 'time', 'Danach gehen wir essen.', 'Afterwards we''ll go and eat.', null),
  (1074, 'seit', 'since; for (time up to now)', 'preposition', null, null, 'A2', 74, 'time', 'Ich wohne seit drei Jahren in Berlin.', 'I''ve lived in Berlin for three years.', 'seit + Dativ, with present tense in German.'),
  (1075, 'bis', 'until', 'preposition', null, null, 'A2', 75, 'time', 'Ich arbeite heute bis sechs.', 'I''m working until six today.', null),
  (1076, 'zwischen', 'between', 'preposition', null, null, 'A2', 76, 'travel', 'Der Supermarkt ist zwischen der Bank und der Post.', 'The supermarket is between the bank and the post office.', null),
  (1077, 'gegenüber', 'opposite', 'preposition', null, null, 'A2', 77, 'travel', 'Die Apotheke ist gegenüber vom Bahnhof.', 'The pharmacy is opposite the station.', null),
  (1078, 'weil', 'because', 'conjunction', null, null, 'A2', 78, 'communication', 'Ich komme nicht, weil ich krank bin.', 'I''m not coming because I''m ill.', 'weil sends the verb to the end.'),
  (1079, 'dass', 'that (conjunction)', 'conjunction', null, null, 'A2', 79, 'communication', 'Ich glaube, dass er recht hat.', 'I think (that) he''s right.', 'dass sends the verb to the end.'),
  (1080, 'wenn', 'if; when(ever)', 'conjunction', null, null, 'A2', 80, 'communication', 'Wenn du Zeit hast, ruf mich an.', 'If you have time, give me a call.', null),
  (1081, 'Gute Besserung', 'get well soon', 'phrase', null, null, 'A2', 81, 'appointments', 'Du bist krank? Gute Besserung!', 'You''re ill? Get well soon!', null),
  (1082, 'Es tut mir leid', 'I''m sorry', 'phrase', null, null, 'A2', 82, 'communication', 'Es tut mir leid, ich bin zu spät.', 'I''m sorry, I''m late.', null),
  (1083, 'Das kommt darauf an', 'it depends', 'phrase', null, null, 'A2', 83, 'communication', 'Kommst du mit? – Das kommt darauf an.', 'Are you coming? – It depends.', null),
  (1084, 'Viel Glück', 'good luck', 'phrase', null, null, 'A2', 84, 'communication', 'Viel Glück bei der Prüfung!', 'Good luck in the exam!', null),
  (1085, 'Das macht nichts', 'never mind, it doesn''t matter', 'phrase', null, null, 'A2', 85, 'communication', 'Du bist zu spät? Das macht nichts.', 'You''re late? Never mind.', null),
  (1086, 'Bis bald', 'see you soon', 'phrase', null, null, 'A2', 86, 'communication', 'Schöne Ferien und bis bald!', 'Have a nice holiday and see you soon!', null),
  (2001, 'Entscheidung', 'decision', 'noun', 'die', 'Entscheidungen', 'B1', 1, 'work', 'Das war keine leichte Entscheidung.', 'That wasn''t an easy decision.', null),
  (2002, 'Voraussetzung', 'requirement, prerequisite', 'noun', 'die', 'Voraussetzungen', 'B1', 2, 'work', 'Gute Deutschkenntnisse sind eine Voraussetzung für die Stelle.', 'Good German is a requirement for the job.', null),
  (2003, 'Verantwortung', 'responsibility', 'noun', 'die', null, 'B1', 3, 'work', 'In meinem neuen Job habe ich mehr Verantwortung.', 'I have more responsibility in my new job.', null),
  (2004, 'Kündigung', 'notice (of termination), resignation', 'noun', 'die', 'Kündigungen', 'B1', 4, 'work', 'Ich habe gestern meine Kündigung abgegeben.', 'I handed in my notice yesterday.', null),
  (2005, 'Ausbildung', 'vocational training, apprenticeship', 'noun', 'die', 'Ausbildungen', 'B1', 5, 'work', 'Sie macht eine Ausbildung als Krankenschwester.', 'She''s training to be a nurse.', null),
  (2006, 'Unterschied', 'difference', 'noun', 'der', 'Unterschiede', 'B1', 6, 'communication', 'Was ist der Unterschied zwischen den beiden Tarifen?', 'What''s the difference between the two plans?', null),
  (2007, 'Umgebung', 'surroundings, local area', 'noun', 'die', 'Umgebungen', 'B1', 7, 'home', 'Die Umgebung ist ideal für Familien.', 'The area is ideal for families.', null),
  (2008, 'Beschwerde', 'complaint', 'noun', 'die', 'Beschwerden', 'B1', 8, 'shopping', 'Ich habe eine Beschwerde über den Lärm geschrieben.', 'I wrote a complaint about the noise.', null),
  (2009, 'sich verlassen', 'to rely on', 'verb', null, null, 'B1', 9, 'people', 'Du kannst dich auf mich verlassen.', 'You can rely on me.', 'Without sich: verlassen = to leave (a place or person).'),
  (2010, 'sich gewöhnen', 'to get used to', 'verb', null, null, 'B1', 10, 'everyday', 'Ich kann mich nicht an das frühe Aufstehen gewöhnen.', 'I can''t get used to getting up early.', null),
  (2011, 'vermeiden', 'to avoid', 'verb', null, null, 'B1', 11, 'everyday', 'Ich versuche, Stress zu vermeiden.', 'I try to avoid stress.', null),
  (2012, 'überzeugen', 'to convince', 'verb', null, null, 'B1', 12, 'communication', 'Du musst mich nicht überzeugen, ich komme mit.', 'You don''t need to convince me, I''m coming.', null),
  (2013, 'vorschlagen', 'to suggest, to propose', 'verb', null, null, 'B1', 13, 'communication', 'Darf ich etwas vorschlagen?', 'May I suggest something?', null),
  (2014, 'erledigen', 'to get done, to take care of (a task)', 'verb', null, null, 'B1', 14, 'work', 'Ich muss heute noch ein paar Sachen erledigen.', 'I still have to get a few things done today.', null),
  (2015, 'kündigen', 'to quit (a job); to cancel (a contract)', 'verb', null, null, 'B1', 15, 'work', 'Ich will meinen Handyvertrag kündigen.', 'I want to cancel my phone contract.', null),
  (2016, 'zuverlässig', 'reliable', 'adjective', null, null, 'B1', 16, 'work', 'Unser neuer Kollege ist sehr zuverlässig.', 'Our new colleague is very reliable.', null),
  (2017, 'anstrengend', 'exhausting, tiring', 'adjective', null, null, 'B1', 17, 'work', 'Die Woche war echt anstrengend.', 'The week was really exhausting.', null),
  (2018, 'ehrlich', 'honest', 'adjective', null, null, 'B1', 18, 'people', 'Ehrlich gesagt habe ich keine Lust.', 'To be honest, I don''t feel like it.', null),
  (2019, 'vorsichtig', 'careful', 'adjective', null, null, 'B1', 19, 'everyday', 'Sei vorsichtig, die Straße ist glatt.', 'Be careful, the road is slippery.', null),
  (2020, 'ziemlich', 'quite, rather, pretty', 'adverb', null, null, 'B1', 20, 'communication', 'Das Konzert war ziemlich gut.', 'The concert was pretty good.', null),
  (2021, 'allerdings', 'however, mind you', 'adverb', null, null, 'B1', 21, 'communication', 'Die Wohnung ist schön, allerdings etwas teuer.', 'The flat is nice, but a bit expensive, mind you.', null),
  (2022, 'sowieso', 'anyway, in any case', 'adverb', null, null, 'B1', 22, 'communication', 'Ich fahre sowieso in die Stadt.', 'I''m going into town anyway.', null),
  (2023, 'obwohl', 'although', 'conjunction', null, null, 'B1', 23, 'communication', 'Ich gehe joggen, obwohl es regnet.', 'I''m going jogging although it''s raining.', null),
  (2024, 'damit', 'so that', 'conjunction', null, null, 'B1', 24, 'communication', 'Ich erkläre es noch einmal, damit alle es verstehen.', 'I''ll explain it again so that everyone understands.', null),
  (2025, 'Das ist mir egal', 'I don''t mind; I don''t care', 'phrase', null, null, 'B1', 25, 'communication', 'Pizza oder Pasta? – Das ist mir egal.', 'Pizza or pasta? – I don''t mind.', null),
  (3001, 'Herausforderung', 'challenge', 'noun', 'die', 'Herausforderungen', 'B2', 1, 'work', 'Der neue Job ist eine echte Herausforderung.', 'The new job is a real challenge.', null),
  (3002, 'Auswirkung', 'effect, impact', 'noun', 'die', 'Auswirkungen', 'B2', 2, 'work', 'Die Entscheidung hat eine große Auswirkung auf das Team.', 'The decision has a big impact on the team.', null),
  (3003, 'Aufwand', 'effort, expense (time, money)', 'noun', 'der', null, 'B2', 3, 'work', 'Der Aufwand lohnt sich nicht.', 'It isn''t worth the effort.', null),
  (3004, 'Maßnahme', 'measure (action taken)', 'noun', 'die', 'Maßnahmen', 'B2', 4, 'work', 'Die Firma plant neue Maßnahmen gegen den Stress.', 'The company is planning new measures against stress.', null),
  (3005, 'berücksichtigen', 'to take into account', 'verb', null, null, 'B2', 5, 'work', 'Wir müssen auch die Kosten berücksichtigen.', 'We also have to take the costs into account.', null),
  (3006, 'beeinflussen', 'to influence', 'verb', null, null, 'B2', 6, 'communication', 'Das Wetter kann unsere Stimmung stark beeinflussen.', 'The weather can strongly influence our mood.', null),
  (3007, 'nachvollziehen', 'to follow (someone''s reasoning), to see why', 'verb', null, null, 'B2', 7, 'communication', 'Ich kann deine Entscheidung gut nachvollziehen.', 'I can see why you made that decision.', null),
  (3008, 'umsetzen', 'to implement, to put into practice', 'verb', null, null, 'B2', 8, 'work', 'Jetzt müssen wir den Plan nur noch umsetzen.', 'Now we just have to put the plan into practice.', null),
  (3009, 'nachhaltig', 'sustainable', 'adjective', null, null, 'B2', 9, 'everyday', 'Wir wollen nachhaltig leben und weniger Plastik kaufen.', 'We want to live sustainably and buy less plastic.', null),
  (3010, 'zumindest', 'at least', 'adverb', null, null, 'B2', 10, 'communication', 'Ruf zumindest kurz an, wenn du später kommst.', 'At least give me a quick call if you''re going to be late.', null),
  (3011, 'sich auseinandersetzen', 'to deal with, to engage with', 'verb', null, null, 'B2', 11, 'communication', 'Ich muss mich mit dem Thema genauer auseinandersetzen.', 'I need to look into the topic more closely.', null),
  (3012, 'Es lässt sich nicht leugnen', 'there''s no denying (that)', 'phrase', null, null, 'B2', 12, 'communication', 'Es lässt sich nicht leugnen, dass die Mieten steigen.', 'There''s no denying that rents are rising.', null)
on conflict (id) do update set
  german = excluded.german,
  english = excluded.english,
  part_of_speech = excluded.part_of_speech,
  article = excluded.article,
  plural = excluded.plural,
  cefr_level = excluded.cefr_level,
  frequency_rank = excluded.frequency_rank,
  topic = excluded.topic,
  example_sentence = excluded.example_sentence,
  example_translation = excluded.example_translation,
  usage_note = excluded.usage_note;

delete from public.vocabulary_grammar_links;
insert into public.vocabulary_grammar_links (word_id, topic_id) values
  (2, 101),
  (3, 101),
  (14, 103),
  (30, 111),
  (31, 111),
  (32, 111),
  (33, 110),
  (35, 103),
  (43, 110),
  (43, 114),
  (59, 112),
  (60, 112),
  (61, 112),
  (92, 111),
  (95, 110),
  (127, 109),
  (127, 114),
  (128, 109),
  (128, 114),
  (129, 110),
  (129, 114),
  (130, 110),
  (130, 114),
  (131, 110),
  (131, 114),
  (132, 110),
  (132, 114),
  (133, 110),
  (133, 114),
  (134, 104),
  (135, 104),
  (142, 209),
  (1001, 201),
  (1001, 210),
  (1003, 112),
  (1013, 112),
  (1015, 112),
  (1036, 201),
  (1036, 210),
  (1037, 201),
  (1045, 201),
  (1045, 210),
  (1046, 110),
  (1046, 204),
  (1047, 110),
  (1047, 204),
  (1048, 110),
  (1048, 204),
  (1051, 112),
  (1052, 112),
  (1053, 201),
  (1054, 210),
  (1055, 201),
  (1055, 210),
  (1074, 110),
  (1074, 114),
  (1076, 203),
  (1077, 110),
  (1078, 202),
  (1079, 202),
  (1080, 202),
  (1082, 110),
  (2009, 201),
  (2009, 210),
  (2010, 201),
  (2010, 210),
  (2013, 112),
  (2023, 202),
  (2024, 305),
  (2025, 110),
  (3007, 112),
  (3008, 112),
  (3011, 201),
  (3011, 210);
commit;
