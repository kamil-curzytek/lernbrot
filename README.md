# Lernbrot: your daily bread of German

Practical German, ten words a day.

MVP of a German tutor (CEFR A1 → B2). It proves one loop:

> Learn 10 words → study cards → quiz → results saved → reviews scheduled → the cloud prepares tomorrow's session (PC can be off) → next day: review words + new words.

---

## Status at a glance

### Implemented and tested (74 automated tests, `npm test`)

| Area | Where | Tested how |
|---|---|---|
| Database schema, constraints, RLS, privileges | `supabase/migrations/…0001_schema.sql` | Real Postgres (PGlite) with Supabase-style roles and grants |
| Daily session selection, idempotent | `create_daily_session_for()` in `…0002_functions.sql` | Integration tests |
| Quiz submission (attempt + every answer + schedule, one transaction) | `submit_quiz()` | Integration tests, including tampering cases |
| Daily cloud job | `run_daily_learning_job()` | Integration tests (timing, timezones, no duplicates, audit log) |
| Spaced repetition | `src/lib/spacedRepetition/` | Unit tests, including timezones and DST |
| Quiz engine (7 question types, ambiguity rejection, difficulty by progress) | `src/lib/quiz/` | Unit tests + every generated question for all 266 words is checked |
| Seed content: 266 words, 16 A1 + 12 A2 lessons, B1/B2 outline | `content/*.json` → `supabase/seed/content.sql` | Content quality tests |
| React app: onboarding, dashboard, study cards, quiz, results, grammar, vocabulary, review, progress | `src/` | Type-checks and builds. Renders the setup screen locally. **Not yet run against a live Supabase project.** |

The full definition-of-done loop runs as one integration test (`tests/db.test.ts`): sign up → choose A1 → 10 new words → quiz 8/10 → two missed words identified → all answers saved → review dates set → next morning the job prepares the next session (8 review + 2 new, the missed words first) → day-2 quiz uses harder questions for known words.

### Requires external configuration (not yet done or verified)

| Item | Why it isn't verified yet |
|---|---|
| A Supabase project with the migrations + seed applied | Needs your Supabase account |
| **pg_cron schedule** (`…0003_daily_cron.sql`) | pg_cron only exists on the real server, so the scheduling itself is untested. The job function it calls is tested. |
| Hosting the frontend (any static host) | Needs your hosting account |
| Auth email settings (Site URL / redirect URLs) | Project-specific |
| Cross-device check and "PC off overnight" check | Possible only once deployed. See [Verifying the PC-off loop](#verifying-the-pc-off-loop) |
| Notifications | Not implemented (see Known limitations) |

---

## Architecture

```text
             ┌───────────────────────── SUPABASE (cloud) ─────────────────────────┐
             │ Postgres: vocabulary · grammar · profiles · progress · sessions ·  │
             │           quiz attempts/answers · job audit                        │
             │ Auth (email + password)       RLS on every user table              │
             │                                                                    │
             │ SQL functions                    pg_cron (hourly, minute :05)      │
             │  create_my_daily_session() ◄──┐   └─► run_daily_learning_job()     │
             │  submit_quiz()                │          └─► create_daily_session_for()
             └───────────────▲───────────────┴────────────────────────────────────┘
                             │ supabase-js (anon key + user JWT)
                ┌────────────┴─────────────┐
                │  React app (static site) │  study cards · quiz engine · spaced repetition
                └──────────────────────────┘
```

**Why this shape:**
- **The daily job lives inside Supabase (pg_cron).** It runs next to the data, needs no extra service, and keeps working with your PC off. Session selection is a single SQL function, used by both the job and the app, so they can't drift apart.
- **Cowork / Claude scheduled tasks were not used.** In this environment they run on the local machine, which breaks the PC-off requirement. Claude cloud routines could call an endpoint on a schedule, but pg_cron is simpler and has no moving parts outside the database.
- **The UI is a normal Vite + React app, not an Artifact.** Artifacts are sandboxed pages. Their built-in storage would make the Artifact the database (ruled out), and they are not guaranteed network access to your Supabase project. A static React build can be hosted anywhere and talks to Supabase directly.
- **Deterministic core, no AI.** Word selection, scoring, spaced repetition, progress and session creation are plain code. AI features can be added later as optional extras.

### Who computes what

| Concern | Runs in | Notes |
|---|---|---|
| Which words today (selection) | Postgres `create_daily_session_for` | Shared by app and cron |
| Quiz questions + grading | Browser, `src/lib/quiz` | Seeded by session id, so the same quiz appears on every device |
| Next review date (spaced repetition) | Browser, `src/lib/spacedRepetition` | Configurable. Submitted to and validated by `submit_quiz` |
| Storing attempt/answers/progress | Postgres `submit_quiz` | One transaction, one scored attempt per session |

---

## Supabase setup

1. **Create a project** at supabase.com.
2. **Apply the schema.** In the SQL Editor, run these files in order:
   1. `supabase/migrations/20261001000001_schema.sql`
   2. `supabase/migrations/20261001000002_functions.sql`
   3. `supabase/migrations/20261001000003_daily_cron.sql` (enables `pg_cron` and schedules the job. If the extension can't be created from SQL, enable **pg_cron** under Database → Extensions first, then re-run.)
   4. `supabase/migrations/20261005000004_resume_and_target.sql` (resume where you left off + 5–50 words per day)
   5. `supabase/migrations/20261005000005_adaptive_new_words.sql` (fewer new words when reviews pile up)

   For a brand-new project you can instead paste the single combined file `supabase/setup.sql` (all migrations + content).

   Or with the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.
3. **Load content:** run `supabase/seed/content.sql` in the SQL Editor (idempotent, safe to re-run).
4. **Auth:** Authentication → Providers → Email (enabled by default). Under URL Configuration, set the Site URL to your deployed URL and add `http://localhost:5173` to the redirect URLs. Email confirmation can stay on: the app tells new users to check their inbox.
5. **Check the cron job:** `select jobname, schedule, active from cron.job;`

## Environment variables

`.env.local` (copy from `.env.example`):

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Project Settings → API → `anon` public key |

Both are public by design. RLS protects every row. **Never put the `service_role` key in the frontend or in any `VITE_` variable.** Nothing in this project needs it: the cron job runs inside the database as `postgres`.

## Local development

```bash
npm install
npm run dev          # http://localhost:5173 (shows a setup screen until .env.local is set)
npm test             # 74 tests: unit, content, database integration and a 60-day simulation: unit + content + database integration (PGlite, no Docker)
npm run typecheck
npm run seed:build   # regenerate supabase/seed/content.sql after editing content/*.json
```

The database tests (`tests/helpers/db.ts`) run the real migrations and seed on PGlite (Postgres in WASM). They add a small stub for the parts of Supabase the schema depends on: the `auth.users` table, `auth.uid()`, the `anon`/`authenticated` roles and Supabase's default grants. pg_cron is skipped.

## Deployment

`npm run build` produces a static site in `dist/` (relative paths + hash routing, so it works on any static host with no rewrite rules). Deploy to Netlify, Vercel, Cloudflare Pages or GitHub Pages, with the two `VITE_` variables set at build time. Then add the deployed URL to Supabase Auth's Site URL and redirect URLs.

---

## Database schema

| Table | Purpose | Client access |
|---|---|---|
| `profiles` | Level, daily target (5–50 in steps of 5, default 10), timezone, `onboarded_at` | Read own. Update own settings columns only |
| `vocabulary_words` | Shared vocabulary (stable explicit ids) | Read (signed in) |
| `grammar_topics` | Lessons (`content` jsonb, null = outline only) | Read (signed in) |
| `vocabulary_grammar_links` | Word ↔ grammar (e.g. helfen → Dative) | Read (signed in) |
| `vocabulary_progress` | One row per user + word: status, streak, counts, difficulty, `next_review_at` | Read own. Written only by `submit_quiz` |
| `daily_sessions` | One per user + **local date** (`unique (user_id, session_date)`). Also stores where you are: `study_position` (cards gone through) and `quiz_draft` (answers given so far) | Read own. Created only by the session functions |
| `daily_session_words` | The words in each session (`kind` new/review, order) | Read own |
| `quiz_attempts` | Score, duration. `unique (daily_session_id)` | Read own |
| `quiz_answers` | Every answer: type, given, expected, correct | Read own |
| `daily_job_runs` | Audit log of each cron run | None |

Fields beyond the brief and why: `profiles.onboarded_at` (the job skips users who haven't onboarded), `daily_session_words` (stores the selected words), `quiz_attempts.daily_session_id` (one scored attempt per day), `grammar_topics` + links (grammar MVP), `daily_job_runs` (proves the cloud job ran).

## Authentication & security

- Supabase Auth, email + password. A trigger creates the profile at sign-up.
- RLS is enabled on every table. All table privileges are revoked from `anon`/`authenticated` first, then re-granted minimally: signed-in users can `select` their own rows and update only their profile settings columns.
- All other writes go through `security definer` functions that use `auth.uid()`. `create_daily_session_for` and `run_daily_learning_job` are not callable from the API.
- Tests confirm a user cannot read or modify another user's profile, progress, sessions, attempts or answers. They also confirm that `anon` can read nothing and that tampered quiz submissions are rejected.

## Daily session algorithm (`create_daily_session_for`)

Target `N` = `profiles.daily_word_target`. The minimum number of new words depends on the review backlog (`D` = words due by the end of today):

| Backlog | Minimum new words | At N = 10 |
|---|---|---|
| `D ≤ N` (on track) | `ceil(0.2·N)` | 8 review + 2 new |
| `N < D < 2N` (busy) | `ceil(0.1·N)` | 9 review + 1 new |
| `D ≥ 2N` (catch-up day) | 0 | 10 review |

A 60-day simulation (`tests/simulation.test.ts`) showed that a fixed minimum of 2 new words a day lets the backlog grow without limit (86 overdue words after 60 days). With the adaptive rule it stays between roughly 8 and 21.

1. **Already have a session for (user, local date)?** Return it (idempotent. The unique constraint also covers concurrent calls).
2. **Due reviews:** `next_review_at` before the end of the learner's local day. Words answered wrong more often than right come first, then the most overdue. Capped at `N − min_new`.
3. **Frequently-wrong words that aren't due yet:** at most 2, only when there's room.
4. **New words:** the learner's level first, then lower levels, then higher. Within a level, topics are interleaved (round-robin by frequency rank) for variety.
5. **Ran out of new words?** Top up with the earliest upcoming reviews.
6. Save the session and its words. Mark the review words' status `review`.

Results: a new user gets 10 new words; typical later days get 4–6 review + 4–6 new; a large backlog gets 8 review + 2 new. The total never exceeds `N`.

## Spaced repetition (`src/lib/spacedRepetition`)

Config (`config.ts`): `intervalsDays: [1, 2, 4, 7, 14, 30, 60]`.

- **Correct:** streak + 1, next review = local midnight of today + `intervals[streak]` days. Status: streak 1 = `learning`, 2–3 = `familiar`, ≥ 4 = `strong`.
- **Incorrect:** status `learning`, next review tomorrow (`lapseIntervalDays`), streak halved (`lapseStreakFactor: 0.5`, so a strong word recovers faster than a new one), difficulty + 2.
- Reviews land on **local midnight**, so a word due "in 1 day" is in tomorrow's session whatever time today's quiz was taken.
- States: `new` (not quizzed), `learning`, `familiar`, `strong`, `review` (selected into a session as a review, until it's answered).

## Quiz engine (`src/lib/quiz`)

One question per session word, so a 10-word session gets a 10-question quiz. The question's difficulty depends on the word's progress:

| Level | When | Types |
|---|---|---|
| 1 | new / just missed | German → English (choice) |
| 2 | 1 correct | English → German (choice), context: which word fits (choice) |
| 3 | 2–3 in a row | fill in the blank (typed), English → German (typed) |
| 4 | 4+ in a row | article der/die/das, plural (typed) |

Each word can get a type from its own level or one level either side. The generator spreads types out (day one already mixes three types) and orders questions easiest first.

**Ambiguity rules.** A question is rejected and another type tried when:
- a distractor's English overlaps the answer's (shared content word, or a near-synonym group such as *beautiful/pretty/nice*)
- there aren't 3 clean distractors at the same CEFR level
- the word doesn't appear exactly once in its example sentence (needed for blanks)
- a typed English → German prompt shares its main meaning with another word
- a noun has no article or plural

Sentence questions always show the translation, so only one option fits. Typed answers ignore case and punctuation and accept `ae/oe/ue/ss` for `ä/ö/ü/ß`. A wrong article is still wrong.

## Verifying the PC-off loop

After deploying:
1. Sign up, choose A1, finish the quiz.
2. Close the app and turn the PC off overnight.
3. Next morning, without opening the app, check from your phone in the Supabase dashboard SQL editor:
   ```sql
   select * from cron.job_run_details order by start_time desc limit 5;
   select * from public.daily_job_runs order by ran_at desc limit 5;
   select session_date, review_word_count, new_word_count, created_at from public.daily_sessions order by created_at desc limit 5;
   ```
   A session for today, created around 03:05 your time, means the cloud prepared it.
4. Open the app on another device and sign in: the same progress and today's session appear.

## Adding vocabulary

Edit `content/vocabulary.json` (the format note is at the top of the file):
- Give each word a new, never-reused id (A1 1–999, A2 1001–1999, B1 2001–2999, B2 3001–3999). Its position within its level sets the frequency rank.
- Nouns: `de` without the article, `art` der/die/das, `pl` without "die" (omit for uncountables).
- Reflexive verbs: `"de": "sich erinnern"`.
- Write a natural example. Where natural, use the dictionary form (e.g. with a modal verb) so the word can be blanked.
- Make the English gloss specific enough to tell the word apart from others ("to know (a fact)").

Then run `npm test` (the content and ambiguity checks catch most problems), `npm run seed:build`, and run `supabase/seed/content.sql` in Supabase.

## Adding grammar

Edit `content/grammar.json`. A full lesson has `what`, `rule`, `examples`, `mistake`, `everyday` and `remember`. Leave `lesson` out for outline-only topics. Link words to topics through each word's `grammar: ["slug"]`. Rebuild the seed as above.

---

## Known limitations

- **Not yet run end-to-end against a hosted Supabase project.** The SQL is tested on real Postgres with a Supabase auth stub. Hosted-only behaviour (pg_cron scheduling, Auth email flows, PostgREST) is untested. The React screens beyond the setup screen have been type-checked and built but not used against live data.
- **Notifications are not implemented.** Possible later: pg_net from the job to an Edge Function that sends email or push.
- Your place is saved after every study card and every quiz answer (`save_session_progress`), so leaving and coming back, on any device, resumes where you were. Saved answers can't be changed. Quiz duration counts from the first answer, including any break.
- One scored quiz per day. There is no extra practice mode yet.
- Spaced-repetition results are computed in the browser and checked by `submit_quiz` (bounds, statuses, words in the session). A user could only change their own schedule.
- Words per day (5–50) can be changed from the home screen or Progress. If today's lesson hasn't been started it's rebuilt immediately, otherwise the change applies from the next day (`update_daily_target`). Changing the level applies from the next session. The timezone is set at onboarding and can be updated in Progress.
- Distractor "different topic" and synonym lists are heuristics. The shown translation is what guarantees context questions have one answer.
- The seed has 266 words (143 A1 · 86 A2 · 25 B1 · 12 B2), slightly above the 150–250 guideline.

## Next phases

- **Phase 2:** 500+ words per level, the full A1–B2 grammar, sentence production, listening, grammar quizzes, mixed tests.
- **Phase 3:** detect weak topics and categories, adaptive difficulty, grammar recommendations, recurring-mistake detection, and optional AI practice.

## Project layout

```text
content/                 vocabulary.json, grammar.json (source of truth for seed content)
scripts/build-seed.mjs   content -> supabase/seed/content.sql
supabase/migrations/     schema + RLS, functions, pg_cron schedule
supabase/seed/           generated content.sql
src/lib/spacedRepetition intervals + scheduling (pure)
src/lib/quiz             question builders, generator, grading (pure)
src/lib/dailySession     streak and summary stats (selection is in SQL)
src/lib/supabase         client
src/services             profile, vocabulary, progress, quiz, dailySession, grammar
src/pages, components    UI
tests/                   unit, content, database integration
```
