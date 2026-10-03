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
