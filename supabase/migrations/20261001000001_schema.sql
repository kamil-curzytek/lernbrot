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
