# Trae's Training Log

A phone-friendly page for Trae's training sessions. Tap a circle to tick off each set, tap **Examples** to see YouTube demos of an exercise, and leave notes on any exercise or on the whole session. Notes stay in **Notes to review** until someone marks them reviewed. John and Trae see each other's ticks and notes live.

It's a plain static site (no build step): `index.html`, `style.css`, `app.js`, `store.js`, `config.js`, and the `sessions/` folder. Ticks and notes are saved in a free [Supabase](https://supabase.com) database. If `config.js` is left blank the site runs in demo mode and saves only on the current device.

## Trainer console

`console.html` (e.g. `https://your-site/console.html`) is the trainer's side. Sign in with a trainer email to:

- **Athletes**: add athletes and trainers, rename them, turn sign-in off. People are kept in the database, not in this repo.
- **Week**: every active athlete's week side by side (a row per athlete, a column per day), filtered by group. Drag a session to another day to move it, or onto another athlete to copy it there with the scaling screen; **Copy week…** on a row copies that athlete's whole week. Groups are set in Athletes → Edit once `supabase/012_member_groups.sql` has been run.
- **Programs**: paste or upload a session (same JSON as the `sessions/` files), check it with a live preview, pick the athlete (or all athletes), the date, and publish. Each program's editor has **Copy session to…** and **Copy week to…** buttons (the list has **Copy to…** on each row, and **Copy a week** at the top). Copy session puts one session on another athlete (or the same one) on a date you pick; copy week copies every session the athlete has in that Monday–Sunday week to another athlete (or the same one, another week) as new programs, scaled by a percentage: reps to the nearest whole rep, bar weights to the nearest 5 kg, and dumbbells and kettlebells to a real size you pick from the three closest (e.g. a 22.5 kg dumbbell at 80% offers 20, 17.5 or 15). Sets, times, distances and the first athlete's past loads aren't scaled. Before copying, every changed line can be edited (sets, target, suggested kg, extra, WOD description), undone back to the original, or reset to the scaled version; whole sessions can be left out or moved to another date. The gym's dumbbell and kettlebell sizes can be edited on the same screen. The rules live in `scale.js`; `node tests/scale.test.js` checks them.
- **Feedback**: every athlete's notes in one inbox, with reply and mark reviewed, plus finished-session summaries.
- **Leaderboards**: create WODs (for time, max reps, max load or AMRAP), enter or fix scores, hide a score, open, close or hide a board. Athletes see open and closed boards in a Leaderboards tab and log their own scores on open ones.

The console needs `supabase/004_trainer_console.sql` to have been run (see setup step 1). Until then the athlete site works exactly as before.

On the athlete site a trainer gets an athlete picker in the header to see and tick any athlete's log.

## Adding a new session

Use **Programs → New program** in the console. Once any program is published for an athlete, the athlete site shows those instead of the files.

The program editor opens in **Builder**: the exercise library sits on the left, and each exercise is a block you drag into a program block (Prep, Speed & Power, Primary Strength and so on), or add with **+** to the highlighted block. Drag exercises to reorder them or move them between blocks, and edit sets, target, status and cue in place. Each library exercise shows the last time the athlete did it (from published programs and the `sessions/` files). The library starts from `exercises.json`, and any exercise used in a saved program joins it automatically, so a new one only needs adding once with **+ New exercise**. Empty blocks are left out when you save. The **JSON** tab still shows and edits the same session JSON.

The **Library** tab lists every exercise grouped by movement family (Clean, Snatch, Jerk & Overhead, Squat & Lunge, Deadlift & Hinge, Gymnastics, Kettlebell & Dumbbell, Cardio and so on) and a WOD library: CrossFit Open workouts 2011–2025, the benchmark Girls, Hero WODs and tests, also grouped by primary movement. A WOD can start a new program or a leaderboard from there. In the builder, the side panel switches between **Exercises** and **WODs**; drag a WOD above or below any block (or press **+**) and it becomes its own block, with each movement as an exercise and the full workout as the block's note, which athletes see on the site and in the iOS app. Both libraries are plain files (`exercises.json`, `wods.json`), so no database change is needed; add to them there.

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
| `blocks[]` | `key` (A, B… or 1, 2…), `name`, optional `rounds`, `note` (text shown above the block, e.g. a WOD's full write-up), `wod` (the id of the library WOD it came from) |
| `blocks[].exercises[]` | `id`, `name`, `sets` (number of tick circles), `target` (e.g. "10 reps"), optional `status` (`new`, `back`, `swap`, `watch`, `hold`), `cue`, `extra` (RPE / previous loads), `search` (YouTube search words), `video` (a specific YouTube link, replaces the search; YouTube links also play inline), `log` (what each set asks for: `"kg"` a weight box, reps change on tap; `"reps"` a reps box for bodyweight work; `"secs"` a seconds box for holds; `"tick"` a plain done/not done item, e.g. a follow-along video; `"1rm"` a 1RM test: a kg box, and a heavier single fills in that lift's 1RM (a target or name with "1RM" or "1 rep max" counts too). Without it, a target in seconds such as "30 s" gets a seconds box and anything else a kg box), `pct` (e.g. `0.75` to suggest 75% of the lift's estimated 1RM), `pcts` (one % per set, e.g. `[0.7, 0.75, 0.8]`, so later sets scale up or down from the weight typed in), `suggestKg` (a fixed suggested weight) |
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

To train as an athlete yourself on your trainer email, run `supabase/006_trainer_also_athlete.sql`, then tick **Trainer also trains** on your row in the console's Athletes tab. You then show up with the athletes, and can pick your own log on the athlete site.

For leaderboards that athletes join from their programs, run `supabase/007_wod_boards.sql`. Then, when you save a program with a WOD in it, the console asks **Add to leaderboard?**: pick an existing board for that WOD, start a new one, or none. The program's athlete (or every active athlete, for an "All athletes" program) goes on the board, and everyone on a board gets a notification in their training log (the bell in the header) whenever someone adds a score. Logging a score also puts you on the board. When a published program has a WOD the athlete has done before, they get a notification with their last and best score, and the session shows their earlier results above the WOD with a **Log score** button. Board members can be added or removed on each board's page. Before 007 runs, the pop-up still links the board but nobody is added and no notifications are sent.

After 004, add and rename people in the console (Athletes). Before 004, only the emails in `allowed_emails` can see or change anything; to add someone, run `insert into allowed_emails values ('their@email.com');` in the SQL Editor.

### Privacy hardening (health information)

Run `supabase/014_privacy_hardening.sql` once (after 012). It shuts signed-out visitors out of every table and function (no app needs them before sign-in), stops trigger functions being called through the API, fixes the advisor's search-path warnings, and adds an append-only `audit_log`: who added, changed or deleted a note, tick, 1RM, finish, program, score or member, and when. The log keeps ids and changed column names only, never the note text or numbers, and only trainers can read it. Nobody can edit or delete it through the API.

Training notes, injury cues and session summaries are health information under the Privacy Act, so keep real people's emails, names and notes out of this repo (it is public) and in the database.

### Payments (Stripe)

Members pick a plan on their **Profile** (`profile.html` on the website, or the Profile tab in the iPhone app) and pay on Stripe's own page. Trainers create and price plans in the console's **Plans** tab, which also shows who is on which plan and whether they've paid. Changing a plan, updating a card, invoices and cancelling are done by the member in Stripe's customer portal (the **Manage billing** button). Card details never reach Supabase or this repo; Supabase keeps only the Stripe customer id, the plan and the subscription status. Stripe only gets the member's email, so keep health details out of plan names.

Setup (test mode first, then the same steps again with live keys):

1. Run `supabase/015_profile_billing.sql` in the SQL Editor (after `014`).
2. In Stripe (test mode): **Developers → API keys**, copy the **Secret key** (`sk_test_…`).
3. **Settings → Billing → Customer portal**: turn on "Customers can switch plans" (add your plans' products once they exist), cancellations and invoice history, then **Save**. Checkout works without this; Manage billing doesn't.
4. Deploy the edge functions (Supabase CLI) and add the secrets in **Supabase → Edge Functions → Secrets**: `STRIPE_SECRET_KEY`, `SITE_URL` (the website address, no trailing slash) and, after step 5, `STRIPE_WEBHOOK_SECRET`.
5. **Developers → Webhooks → Add endpoint**: `https://zaftplbijgkhnbmwegwt.supabase.co/functions/v1/stripe-webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
6. Add a plan in the console's Plans tab, then choose it on your Profile and pay with the test card 4242 4242 4242 4242.

The iPhone app opens Stripe in Safari inside the app. Apple allows that instead of in-app purchase because a gym membership is a service used in person (App Review Guideline 3.1.3(e)); don't sell app-only digital content through it.

### Data for other apps (iOS)

The iPhone app in `ios/` uses these (see `ios/README.md` for how to open and run it in Xcode).

Everything lives in Supabase, readable with the anon key plus a signed-in user, with row-level security doing the filtering:

| Table / function | What it holds |
|---|---|
| `whoami()` | The signed-in person's email, name and role (`trainer`, `coach` (016: bookings only) or `athlete`) |
| `programs` | Published sessions: `id`, `athlete_email` (null = everyone), `date`, `title`, `body` (the session JSON) |
| `ticks`, `notes`, `session_finishes`, `lift_maxes` | Per-athlete feedback, keyed by `athlete_email` + `session_id` (= program `id`) |
| `wods`, `wod_board()` | WODs and their ranked boards (names only, best score per athlete). Scores: seconds for time, reps, kg, or rounds × 1000 + reps; `wod.js` formats them |
| `wod_results` | An athlete's own scores; insert one to log a score on an open WOD. `detail` (jsonb, after `011`) holds rounds, what was actually done, and timer splits |
| `log_benchmark()` | From `supabase/008_benchmarks.sql`: log a benchmark (wods.json id) and open its leaderboard if there isn't one |
| `wod_board_members` | (007) Who is on each leaderboard; an athlete can read their own rows |
| `my_profile()`, `update_my_profile()` | (015) The signed-in person's details and membership; change your own name, phone and emergency contact |
| `plans`, `subscriptions` | (015) Membership plans (active ones) and your own Stripe subscription status |
| `notifications` | (007) Each person's inbox: `kind` `score`, `board_added` or `wod_again`, `title`, `body`, `read_at`; read and mark your own |
| `gym_slot_list(p_from, p_to)` | (016) Rehab gym sessions in a time range: type (`rehab` / `open_gym`), `capacity`, `booked`, and your own booking (`my_booking_id`, `my_status`) |
| `bookings` | (016) Insert `{slot_id, member_email: you}` to book, update `status` to `cancelled` to cancel. The database refuses full, cancelled or started sessions. Trainers and coaches read and change all of them, including walk-ins (`guest_name`) and `attended` / `no_show` |
| `group_colours` | (016) A colour (`#RRGGBB`) per member group; a person shows in their first coloured group |

### 2. Hosting (Vercel)

1. Sign in at vercel.com with GitHub and choose **Add New → Project**.
2. Import this repo. Leave every setting at its default (Framework: Other, no build command) and press **Deploy**.
3. Every merge to `main` redeploys automatically.

On a phone, open the site and use **Share → Add to Home Screen** so it opens like an app.
