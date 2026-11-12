# Trae's Training Log

A phone-friendly page for Trae's training sessions. Tap a circle to tick off each set, tap **Examples** to see YouTube demos of an exercise, and leave notes on any exercise or on the whole session. Notes stay in **Notes to review** until someone marks them reviewed. John and Trae see each other's ticks and notes live.

It's a plain static site (no build step): `index.html`, `style.css`, `app.js`, `store.js`, `config.js`, and the `sessions/` folder. Ticks and notes are saved in a free [Supabase](https://supabase.com) database. If `config.js` is left blank the site runs in demo mode and saves only on the current device.

## Adding a new session

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
| `blocks[].exercises[]` | `id`, `name`, `sets` (number of tick circles), `target` (e.g. "10 reps"), optional `status` (`new`, `back`, `swap`, `watch`, `hold`), `cue`, `extra` (RPE / previous loads), `search` (YouTube search words), `video` (a specific YouTube link, replaces the search), `pct` (e.g. `0.75` to suggest 75% of the lift's estimated 1RM), `suggestKg` (a fixed suggested weight) |
| `next[]` | Next progressions, listed at the bottom |
| `planUrl` | Link to the full rehab plan |

## One-time setup

### 1. Database (Supabase)

1. Create a free project at supabase.com.
2. Open **SQL Editor → New query**, paste in `supabase/schema.sql`, replace `JOHN_EMAIL_HERE` and `TRAE_EMAIL_HERE` with the two login emails, and run it.
3. Under **Authentication → URL Configuration**, set **Site URL** to the website address (from step 2 below) and add it under **Redirect URLs** too.
4. Under **Project Settings → API**, copy the **Project URL** and the **anon public** key into `config.js`. Add friendly names under `people`.

Sign-in works with a password (no email needed) or a one-tap email link. Supabase free projects only send a few emails an hour, so passwords are easier. To give someone a password: **Authentication → Users → Add user → Create new user**, enter the email and a password, tick **Auto Confirm User**.

Then run `supabase/002_skip_finish_notify.sql` the same way (fill in the ntfy topic and the admin email first). It adds the Skip button, Finish session, and phone notifications: install the free **ntfy** app and subscribe to the same topic to get a push for every new note and every finished session.

Only the emails in `allowed_emails` can see or change anything. To add someone later, run `insert into allowed_emails values ('their@email.com');` in the SQL Editor.

### 2. Hosting (Vercel)

1. Sign in at vercel.com with GitHub and choose **Add New → Project**.
2. Import this repo. Leave every setting at its default (Framework: Other, no build command) and press **Deploy**.
3. Every merge to `main` redeploys automatically.

On a phone, open the site and use **Share → Add to Home Screen** so it opens like an app.
