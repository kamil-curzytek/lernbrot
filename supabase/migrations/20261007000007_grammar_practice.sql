-- Grammar practice (research/grammar-strategy/grammar-strategy.md).
-- Lessons are split into small skills (grammar_skills, seeded from content/grammar/*.txt). After
-- practising a skill on its lesson page it is "studied" and gets an FSRS memory state like a word;
-- each daily session then adds up to 3 due grammar skills (extra to the words-per-day target),
-- mixed across topics. Every grammar answer is stored with an error category for the weak-spot view.

create table if not exists public.grammar_skills (
  id         int  primary key,
  topic_id   int  not null references public.grammar_topics (id) on delete cascade,
  slug       text not null unique,
  title      text not null,
  category   text not null check (category in ('case','gender','verb_form','word_order','adjective_ending','preposition','pronoun','negation','tense','mood','other')),
  requires   int[] not null default '{}',
  item_count int  not null check (item_count > 0),
  sort_order int  not null
);

create table if not exists public.grammar_progress (
  user_id         uuid not null references auth.users (id) on delete cascade,
  skill_id        int  not null references public.grammar_skills (id) on delete cascade,
  status          text not null default 'learning' check (status in ('learning','familiar','strong')),
  studied_at      timestamptz not null default now(),
  streak          int  not null default 0 check (streak >= 0),
  stability       double precision check (stability > 0),
  fsrs_difficulty double precision check (fsrs_difficulty between 1 and 10),
  last_review_at  timestamptz,
  next_review_at  timestamptz not null,
  times_correct   int  not null default 0 check (times_correct >= 0),
  times_incorrect int  not null default 0 check (times_incorrect >= 0),
  updated_at      timestamptz not null default now(),
  primary key (user_id, skill_id)
);

drop trigger if exists grammar_progress_updated_at on public.grammar_progress;
create trigger grammar_progress_updated_at before update on public.grammar_progress
  for each row execute function public.set_updated_at();

create index if not exists grammar_progress_due_idx on public.grammar_progress (user_id, next_review_at);

create table if not exists public.daily_session_grammar (
  session_id uuid not null references public.daily_sessions (id) on delete cascade,
  skill_id   int  not null references public.grammar_skills (id) on delete cascade,
  position   int  not null,
  primary key (session_id, skill_id)
);

create table if not exists public.grammar_answers (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  daily_session_id uuid not null references public.daily_sessions (id) on delete cascade,
  skill_id         int  not null references public.grammar_skills (id) on delete cascade,
  item_id          text not null check (item_id ~ '^[0-9]{4}:[0-9]{1,3}$'),
  user_answer      text not null,
  correct_answer   text not null,
  is_correct       boolean not null,
  error_category   text not null check (error_category in ('case','gender','verb_form','word_order','adjective_ending','preposition','pronoun','negation','tense','mood','other')),
  created_at       timestamptz not null default now()
);

create index if not exists grammar_answers_user_idx on public.grammar_answers (user_id, created_at);

alter table public.daily_sessions add column if not exists grammar_completed_at timestamptz;

alter table public.grammar_skills        enable row level security;
alter table public.grammar_progress      enable row level security;
alter table public.daily_session_grammar enable row level security;
alter table public.grammar_answers       enable row level security;

revoke all on public.grammar_skills, public.grammar_progress, public.daily_session_grammar, public.grammar_answers
  from anon, authenticated;
grant select on public.grammar_skills, public.grammar_progress, public.daily_session_grammar, public.grammar_answers
  to authenticated;

drop policy if exists "grammar skills readable by signed-in users" on public.grammar_skills;
create policy "grammar skills readable by signed-in users" on public.grammar_skills
  for select to authenticated using (true);
drop policy if exists "own grammar progress: read" on public.grammar_progress;
create policy "own grammar progress: read" on public.grammar_progress
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "own session grammar: read" on public.daily_session_grammar;
create policy "own session grammar: read" on public.daily_session_grammar
  for select to authenticated using (
    exists (select 1 from public.daily_sessions s where s.id = session_id and s.user_id = auth.uid()));
drop policy if exists "own grammar answers: read" on public.grammar_answers;
create policy "own grammar answers: read" on public.grammar_answers
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- record_grammar_study: called after the learner practised skills on a lesson page.
-- Studied skills join the review schedule from tomorrow (local midnight). Practising a skill that is
-- already studied changes nothing, so the schedule cannot be reset by accident.
-- ---------------------------------------------------------------------------
create or replace function public.record_grammar_study(p_skill_ids int[])
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_profile public.profiles;
  v_count   int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_skill_ids is null or cardinality(p_skill_ids) = 0 or cardinality(p_skill_ids) > 20 then
    raise exception 'invalid skills';
  end if;
  if exists (select 1 from unnest(p_skill_ids) x(id) where not exists (select 1 from grammar_skills s where s.id = x.id)) then
    raise exception 'unknown skill';
  end if;
  select * into v_profile from profiles where id = v_uid;

  insert into grammar_progress (user_id, skill_id, next_review_at)
  select v_uid, x.id, (((now() at time zone v_profile.timezone)::date + 1)::timestamp at time zone v_profile.timezone)
    from (select distinct unnest(p_skill_ids) as id) x
  on conflict (user_id, skill_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_grammar_review: stores the day's grammar answers and the new schedule of each skill
-- (computed by the browser with FSRS, validated here), once per session.
-- p_entries: [{skill_id, item_id, user_answer, correct_answer, is_correct, error_category,
--              status, streak, stability, fsrs_difficulty, next_review_at}]
-- ---------------------------------------------------------------------------
create or replace function public.submit_grammar_review(p_session_id uuid, p_entries jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_now     timestamptz := now();
  v_session public.daily_sessions;
  v_expect  int;
  v_score   int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_session from daily_sessions where id = p_session_id and user_id = v_uid for update;
  if not found then
    raise exception 'session not found';
  end if;
  if v_session.grammar_completed_at is not null then
    raise exception 'grammar already submitted';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'entries must be an array';
  end if;

  select count(*) into v_expect from daily_session_grammar where session_id = p_session_id;
  if (select count(*) from jsonb_to_recordset(p_entries) e(skill_id int)) <> v_expect
     or (select count(distinct e.skill_id) from jsonb_to_recordset(p_entries) e(skill_id int)) <> v_expect
     or exists (select 1 from jsonb_to_recordset(p_entries) e(skill_id int)
                 where not exists (select 1 from daily_session_grammar sg
                                    where sg.session_id = p_session_id and sg.skill_id = e.skill_id)) then
    raise exception 'entries must cover each grammar skill of the session exactly once';
  end if;

  if exists (
    select 1
      from jsonb_to_recordset(p_entries)
           e(skill_id int, item_id text, user_answer text, correct_answer text, is_correct boolean,
             error_category text, status text, streak int, stability double precision,
             fsrs_difficulty double precision, next_review_at timestamptz)
      left join grammar_skills s on s.id = e.skill_id
     where e.item_id is null or e.item_id !~ '^[0-9]{4}:[0-9]{1,3}$'
        or split_part(e.item_id, ':', 1) <> e.skill_id::text
        or split_part(e.item_id, ':', 2)::int not between 1 and s.item_count
        or e.user_answer is null or length(e.user_answer) > 200
        or e.correct_answer is null or length(e.correct_answer) > 300
        or e.is_correct is null
        or e.error_category is null or e.error_category not in ('case','gender','verb_form','word_order','adjective_ending','preposition','pronoun','negation','tense','mood','other')
        or e.status is null or e.status not in ('learning','familiar','strong')
        or e.streak is null or e.streak < 0
        or e.stability is null or e.stability < 0.001 or e.stability > 36500
        or e.fsrs_difficulty is null or e.fsrs_difficulty < 1 or e.fsrs_difficulty > 10
        or e.next_review_at is null or e.next_review_at <= v_now or e.next_review_at > v_now + interval '1830 days') then
    raise exception 'invalid grammar entries';
  end if;

  insert into grammar_answers (user_id, daily_session_id, skill_id, item_id, user_answer, correct_answer, is_correct, error_category)
  select v_uid, p_session_id, e.skill_id, e.item_id, e.user_answer, e.correct_answer, e.is_correct, e.error_category
    from jsonb_to_recordset(p_entries)
         e(skill_id int, item_id text, user_answer text, correct_answer text, is_correct boolean, error_category text);

  update grammar_progress gp
     set status          = e.status,
         streak          = e.streak,
         stability       = e.stability,
         fsrs_difficulty = e.fsrs_difficulty,
         last_review_at  = v_now,
         next_review_at  = e.next_review_at,
         times_correct   = gp.times_correct + case when e.is_correct then 1 else 0 end,
         times_incorrect = gp.times_incorrect + case when e.is_correct then 0 else 1 end
    from jsonb_to_recordset(p_entries)
         e(skill_id int, is_correct boolean, status text, streak int, stability double precision,
           fsrs_difficulty double precision, next_review_at timestamptz)
   where gp.user_id = v_uid and gp.skill_id = e.skill_id;

  update daily_sessions set grammar_completed_at = v_now where id = p_session_id;

  select count(*) filter (where e.is_correct) into v_score
    from jsonb_to_recordset(p_entries) e(is_correct boolean);
  return v_score;
end;
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

  -- 5. Grammar: up to 3 studied skills that are due, the one most likely forgotten first.
  --    Mixed practice: one skill per lesson topic before a second skill from the same topic.
  insert into daily_session_grammar (session_id, skill_id, position)
  select v_session.id, g.skill_id, row_number() over (order by g.second_of_topic, g.recall, g.skill_id)
    from (
      select gp.skill_id,
             fsrs_retrievability(gp.stability, gp.last_review_at, v_day_start) as recall,
             row_number() over (partition by gs.topic_id
                                order by fsrs_retrievability(gp.stability, gp.last_review_at, v_day_start), gp.skill_id) > 1
               as second_of_topic
        from grammar_progress gp
        join grammar_skills gs on gs.id = gp.skill_id
       where gp.user_id = p_user_id
         and gp.next_review_at < v_day_end
    ) g
   order by g.second_of_topic, g.recall, g.skill_id
   limit 3;

  return v_session;
end;
$$;

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
    -- question ids: "<wordId>:<type>" (vocabulary) or "g<skillId>:<n>" (grammar); both must belong to this session
    if p_answer is null or length(p_answer) > 200
       or not (case
                 when p_question_id ~ '^[0-9]{1,9}:[a-z_]{1,20}$' then
                   exists (select 1 from daily_session_words sw
                            where sw.session_id = p_session_id
                              and sw.word_id = split_part(p_question_id, ':', 1)::int)
                 when p_question_id ~ '^g[0-9]{4}:[0-9]{1,3}$' then
                   exists (select 1 from daily_session_grammar sg
                            where sg.session_id = p_session_id
                              and sg.skill_id = substr(split_part(p_question_id, ':', 1), 2)::int)
                 else false
               end) then
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

revoke execute on function public.create_daily_session_for(uuid, date) from public, anon, authenticated;
revoke execute on function public.record_grammar_study(int[]) from public, anon;
revoke execute on function public.submit_grammar_review(uuid, jsonb) from public, anon;
revoke execute on function public.save_session_progress(uuid, int, text, text) from public, anon;
grant  execute on function public.record_grammar_study(int[]) to authenticated;
grant  execute on function public.submit_grammar_review(uuid, jsonb) to authenticated;
grant  execute on function public.save_session_progress(uuid, int, text, text) to authenticated;

-- make the API see the new tables and functions immediately
notify pgrst, 'reload schema';
