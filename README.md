# Trae's Training Log

A phone-friendly page for Trae's training sessions. Tap a circle to tick off each set, tap **Examples** to see YouTube demos of an exercise, and leave notes on any exercise or on the whole session. Notes stay in **Notes to review** until someone marks them reviewed. John and Trae see each other's ticks and notes live.

It's a plain static site (no build step): `index.html`, `style.css`, `app.js`, `store.js`, `config.js`, and the `sessions/` folder. Ticks and notes are saved in a free [Supabase](https://supabase.com) database. If `config.js` is left blank the site runs in demo mode and saves only on the current device.

## Trainer console

`console.html` (e.g. `https://your-site/console.html`) is the trainer's side. Sign in with a trainer email to:

- **Athletes**: add athletes and trainers, rename them, turn sign-in off. People are kept in the database, not in this repo.
- **Programs**: paste or upload a session (same JSON as the `sessions/` files), check it with a live preview, pick the athlete (or all athletes), the date, and publish. Duplicate a program to reuse it for someone else.
- **Feedback**: every athlete's notes in one inbox, with reply and mark reviewed, plus finished-session summaries.
- **Leaderboards**: create WODs (for time, max reps, max load or AMRAP), enter or fix scores, hide a score, open, close or hide a board. Athletes see open and closed boards in a Leaderboards tab and log their own scores on open ones.

The console needs `supabase/004_trainer_console.sql` to have been run (see setup step 1). Until then the athlete site works exactly as before.

On the athlete site a trainer gets an athlete picker in the header to see and tick any athlete's log.

## Adding a new session

Use **Programs → New program** in the console. Once any program is published for an athlete, the athlete site shows those instead of the files.

The `sessions/` files still work for the original athlete until programs are published for them (the console offers a one-click import of the files, keeping their ids so ticks and notes still line up). To add one the old way:

1. Add a file to `sessions/` named by date, e.g. `sessions/2026-11-26.json`. Copy an existing session as a template.
2. Add the file name to the list in `sessions/index.json`.

The newest session (by `date`) opens by default. Exercise `id`s only need to be unique within their session; don't change an `id` after ticks have been saved against it.

Session fields:

| Field | Meaning |
|---|---|
| `id`, `date` | The date, `YYYY-MM-DD` |
| `short`, `title` | Tab label (e.g. "Session 3") and the heading |
| `summary` | The ankle check shown at the top |
| `blocks[]` | `key` (A, B… or 1, 2…), `name`, optional `rounds` |
| `blocks[].exercises[]` | `id`, `name`, `sets` (number of tick circles), `target` (e.g. "10 reps"), optional `status` (`new`, `back`, `swap`, `watch`, `hold`), `cue`, `extra` (RPE / previous loads), `search` (YouTube search words), `video` (a specific YouTube link, replaces the search), `pct` (e.g. `0.75` to suggest 75% of the lift's estimated 1RM), `pcts` (one % per set, e.g. `[0.7, 0.75, 0.8]`, so later sets scale up or down from the weight typed in), `suggestKg` (a fixed suggested weight) |
| `next[]` | Next progressions, listed at the bottom |
| `planUrl`, `planLabel` | Link to the full plan, and its link text |
| `summaryLabel` | Label for `summary` (default "Ankle check") |

## One-time setup

### 1. Database (Supabase)

1. Create a free project at supabase.com.
2. Open **SQL Editor → New query**, paste in `supabase/schema.sql`, replace `JOHN_EMAIL_HERE` and `TRAE_EMAIL_HERE` with the two login emails, and run it.
3. Under **Authentication → URL Configuration**, set **Site URL** to the website address (from step 2 below) and add it under **Redirect URLs** too.
4. Under **Project Settings → API**, copy the **Project URL** and the **anon public** key into `config.js`. Add friendly names under `people`.

Sign-in works with a password (no email needed) or a one-tap email link. Supabase free projects only send a few emails an hour, so passwords are easier. To give someone a password: **Authentication → Users → Add user → Create new user**, enter the email and a password, tick **Auto Confirm User**.

Then run `supabase/002_skip_finish_notify.sql` the same way (fill in the ntfy topic and the admin email first). It adds the Skip button, Finish session, and phone notifications: install the free **ntfy** app and subscribe to the same topic to get a push for every new note and every finished session.

Then run `supabase/003_lift_maxes.sql`, and `supabase/004_trainer_console.sql` for the trainer console. 004 moves people into a `members` table: the notify admin email becomes the trainer and everyone else an athlete. It gives all existing ticks, notes, finishes and 1RMs to the existing athlete, so nothing is lost. Deploy the website first, then run it; both orders are safe for the existing athlete.

After 004, add and rename people in the console (Athletes). Before 004, only the emails in `allowed_emails` can see or change anything; to add someone, run `insert into allowed_emails values ('their@email.com');` in the SQL Editor.

### Data for other apps (iOS)

Everything lives in Supabase, readable with the anon key plus a signed-in user, with row-level security doing the filtering:

| Table / function | What it holds |
|---|---|
| `whoami()` | The signed-in person's email, name and role (`trainer` or `athlete`) |
| `programs` | Published sessions: `id`, `athlete_email` (null = everyone), `date`, `title`, `body` (the session JSON) |
| `ticks`, `notes`, `session_finishes`, `lift_maxes` | Per-athlete feedback, keyed by `athlete_email` + `session_id` (= program `id`) |
| `wods`, `wod_board()` | WODs and their ranked boards (names only, best score per athlete). Scores: seconds for time, reps, kg, or rounds × 1000 + reps; `wod.js` formats them |
| `wod_results` | An athlete's own scores; insert one to log a score on an open WOD |

### 2. Hosting (Vercel)

1. Sign in at vercel.com with GitHub and choose **Add New → Project**.
2. Import this repo. Leave every setting at its default (Framework: Other, no build command) and press **Deploy**.
3. Every merge to `main` redeploys automatically.

On a phone, open the site and use **Share → Add to Home Screen** so it opens like an app.
