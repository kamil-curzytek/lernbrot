# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Lernbrot is a German-learning app (CEFR A1→B2): React 19 + Vite + TypeScript frontend, Supabase (Postgres + Auth + pg_cron) backend, deployed to GitHub Pages. The repo also contains a separate Python research pipeline (`research/`) that produced a 4,500-entry A1–B2 vocabulary dataset (`data/`), which is **not yet wired into the app** (the app still uses `content/*.json`).

## Commands

```bash
npm run dev            # http://localhost:5173 (shows SetupNeeded screen until .env.local has VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)
npm test               # vitest: unit + content checks + DB integration on PGlite + 60-day simulation
npx vitest run tests/quiz.test.ts            # single file
npx vitest run -t "submit_quiz"              # tests matching a name
npm run typecheck      # tsc --noEmit (also run by npm run build)
npm run build          # static site in dist/
node scripts/build-grammar.mjs   # content/grammar/*.txt -> content/grammar-skills.json, validates every exercise
npm run seed:build     # content/*.json (+ grammar skills) -> supabase/seed/content.sql (run after editing content)
```

Research pipeline (run from `research/`, Python; source corpora in `research/sources/` are git-ignored for licensing):

```bash
python pipeline/build_dataset.py   # authoring/*.psv -> ../data/*.json + build-report.json; prints PROBLEM/warn lines
python pipeline/check_heads.py t4  # near-duplicate head words (arg = authoring file prefix)
python pipeline/missing.py Wort1 Wort2 ...   # which words have no entry yet
python pipeline/tier_coverage.py   # corpus coverage per tier
python pipeline/validate.py        # Goethe cross-check, anti-inflation check, scenario validation -> validation.json
```
Full order from scratch: `goethe.py → frequencies.py → candidates.py → build_dataset.py → tier_coverage.py → validate.py`.

## App architecture

- **Business logic is split deliberately between SQL and the browser.** Daily word selection lives only in Postgres (`create_daily_session_for` in `supabase/migrations/…0002_functions.sql`, adaptive new-word rule in `…0005`), shared by the app RPC `create_my_daily_session()` and the hourly pg_cron job `run_daily_learning_job()`. Quiz generation/grading (`src/lib/quiz`, seeded by session id so it's identical across devices) and spaced-repetition scheduling (`src/lib/spacedRepetition`, FSRS-6 via `ts-fsrs`; memory state `stability`/`fsrs_difficulty`/`last_review_at` per word, migration 0006) run in the browser; results are submitted to `submit_quiz()`, which validates them and writes attempt + answers + progress in one transaction.
- **Security model:** RLS on every table; all table privileges are revoked from `anon`/`authenticated` and re-granted minimally (select own rows, update own profile settings columns). Every other write goes through `security definer` RPCs using `auth.uid()`. Only the anon key is used client-side (`.env.production` holds the public URL + anon key for the Pages build); the service_role key must never appear in the repo or a `VITE_` var.
- **Session resume:** `daily_sessions.study_position` / `quiz_draft`, written by `save_session_progress` after each card/answer. `update_daily_target` (5–50, steps of 5) rebuilds today's session only if it hasn't been started.
- **Frontend:** HashRouter + `base: './'` (works on any static host/sub-path). `src/services/*` wrap supabase-js calls; `src/pages` are routes. `main.tsx` waits for `authReady()` (from `src/lib/supabase/client.ts`) before rendering so password-recovery / email-link tokens in the URL are processed first.
- **DB tests** (`tests/helpers/db.ts`) execute the real migrations + seed on PGlite with a stub for Supabase's `auth` schema, `auth.uid()` (via `request.jwt.claim.sub`), roles and default grants. Any migration file containing `cron` is skipped. New migrations are picked up automatically in filename order.

## Grammar practice

Lessons live in `content/grammar.json`; exercises in `content/grammar/{a1,a2,b1,b2}.txt` (DSL documented at the top of `scripts/build-grammar.mjs`), compiled to `content/grammar-skills.json` (committed; `tests/grammar.test.ts` fails if it is stale) and lazily imported by `src/lib/grammar`. Skill ids are `<topicId><n>` and exercise ids `<skillId>:<position>`, so never renumber; append. The DB only knows skills (`grammar_skills`, seeded) and per-user `grammar_progress` (FSRS state); `create_daily_session_for` adds up to 3 due skills to `daily_session_grammar` (extra to the word target), the client picks the exercise deterministically (`pickItem`) and submits via `submit_grammar_review`. Grammar draft answers use question ids `g<skillId>:<n>` in `save_session_progress`.

## Database change workflow

1. Add a new file in `supabase/migrations/` (timestamped; never edit applied migrations).
2. The user applies SQL manually in the Supabase SQL Editor. `supabase/setup.sql` (all migrations + seed, for new projects) and `supabase/update-YYYY-MM-DD.sql` (incremental, idempotent) are **hand-assembled concatenations** with `-- ===== <file> =====` headers — regenerate/add one when migrations change, and make updates safe to re-run.
3. Pushing to `main` triggers `.github/workflows/deploy.yml` (npm test → build → GitHub Pages, https://kamil-curzytek.github.io/lernbrot/). There is no deploy step for the database.

## Content (current app seed)

`content/vocabulary.json` and `content/grammar.json` are the source of truth for the seed; ids are stable and never reused (A1 1–999, A2 1001–1999, B1 2001–2999, B2 3001–3999); position within a level = frequency rank. `tests/content.test.ts` and the quiz ambiguity checks validate every word, so run `npm test` before `npm run seed:build`. Details on formats, the session algorithm, SR intervals and quiz levels are in README.md.

## Research dataset (`research/`, `data/`)

- Curated entries are authored in `research/authoring/*.psv` (files named `t<tier>-<letter>-<topic>.psv`; `tx-*` = validation gap fills). Format: 14 `|`-separated positional columns `german|type|pos|article|plural|english|cefr|tier|mode|topics|register|example|example_en|grammar`, then optional labelled segments `f=` (verb forms "3sg, preterite, perfect" or adj comparative/superlative), `c=` collocations, `r=` related items, `why=` curator reason. type `w/c/f/p`; mode `a/r/b`; POS codes `noun verb adj adv prep conj pron det num part intj phrase`; plural `∅` = singular-only, `Pl` = plural-only; grammar tags `sep insep refl +Akk +Dat +Gen aux:sein aux:haben irreg pattern prep:X var:X`.
- `build_dataset.py` must report 0 PROBLEM lines. Duplicates: single words are case/article-sensitive (Sie/sie, der/die Leiter); phrases are case- and punctuation-insensitive. The example sentence must contain the item (or tag `pattern`).
- **Anti-inflation rule:** don't add multi-word entries composed of words that already have entries unless they are idiomatic/non-predictable — and then give a `why=`. Plain collocations go in the head word's `c=`. Always check `check_heads.py`/`missing.py` before authoring a batch.
- Docs: `methodology.md`, `sources.md`, `vocabulary-size-analysis.md`, `coverage-analysis.md`, `validation-report.md`, `final-recommendation.md`. Goethe word lists are used as evidence only — don't reproduce them (note `research/candidates.csv` contains Goethe headwords). FOLK spoken-corpus data is pending; placing `research/sources/folk_lemmas*.json` makes the pipeline use it automatically.
