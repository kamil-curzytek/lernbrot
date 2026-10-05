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
