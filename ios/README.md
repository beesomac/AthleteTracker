# Training Log for iPhone

A SwiftUI app that signs in with the same Supabase accounts as the website. Three tabs:

- **Program**: the athlete's published sessions (read-only, except logging a 1RM test).
- **Leaderboards**: every open and closed board, ranked Rx first; log a score on open ones.
- **Benchmarks**: 1RMs for the main lifts (plus any other lift with a number), the Girls, and
  the CrossFit Open by year, each with the athlete's best and history.

Logging a 1RM in a program (an exercise with `log: "1rm"`, or "1RM" in its target or name)
fills in that lift's 1RM benchmark when it beats the current number. The website does the same.

A trainer can switch athletes from the person menu, the same way as the website's athlete picker.

## Open and run it (Mac)

1. `cd ~/Projects/AthleteTracker && git pull` (or check out the branch being reviewed).
2. Open `ios/AthleteTracker.xcodeproj` in Xcode 16 or newer.
3. Wait for Xcode to fetch the **supabase-swift** package (bottom status bar, about a minute
   the first time). If it stalls: **File → Packages → Resolve Package Versions**.
4. Pick an iPhone simulator at the top (e.g. iPhone 16) and press **⌘R**.
5. Sign in with your website email and password.

To run on your own iPhone: select the **AthleteTracker** target → **Signing & Capabilities**,
pick your Apple ID team, plug in the phone (or use Wi-Fi pairing) and choose it as the run
destination. If the bundle id `com.beesomac.AthleteTracker` is taken, change it there.

## Push notifications

The app asks for permission after sign-in and saves the phone's APNs token in `device_tokens`.
Every new row in `notifications` (a new score on your board, being added to a board, "you've done
this before") is then pushed to that person's phones by the `push` edge function; the web bell is
unchanged. Tapping a push marks it read and opens Leaderboards (or Program for "done this before").
Signing out removes the phone's token.

Pushes need the paid developer team: **Signing & Capabilities → Team** must be the paid team, and
the **Push Notifications** capability is switched on by `AthleteTracker.entitlements`. A simulator
can't receive real pushes; use a phone.

One-off setup:

1. **APNs key**: developer.apple.com → Certificates, IDs & Profiles → **Keys** → **+**, tick
   *Apple Push Notifications service (APNs)*, environment *Sandbox & Production*, Continue →
   Register → **Download** the `AuthKey_XXXXXXXXXX.p8` (only downloadable once). Note the
   **Key ID**, and the **Team ID** (top right of the developer site, or Membership details).
2. **Database**: run `supabase/009_push.sql` in the Supabase SQL editor.
3. **Edge function**: deploy `supabase/functions/push` with JWT verification **off**
   (`supabase functions deploy push --no-verify-jwt`, or in the dashboard turn off *Verify JWT*).
4. **Secrets** (Supabase → Edge Functions → Secrets): `APNS_KEY_ID`, `APNS_TEAM_ID`, and
   `APNS_PRIVATE_KEY` = the whole text of the `.p8` file, including the BEGIN/END lines.
5. Run the app on your phone from Xcode, sign in, allow notifications, then test with
   `insert into notifications (recipient_email, kind, title, body) values ('you@example.com', 'score', 'Test', 'Hello from Supabase');`

Debug builds from Xcode use Apple's sandbox, TestFlight/App Store builds use production; the
edge function works out which by itself. Logs: Supabase → Edge Functions → push → Logs.

## Sign-in

Email + password, via Supabase Auth. Accounts are the same as the website's: a trainer
creates a password in Supabase (**Authentication → Users → Add user**, tick *Auto Confirm User*).
The app then calls `whoami()`; anyone not in `members` sees "Not set up yet".
The session is stored in the Keychain, so you stay signed in.

## What it reads

| Source | Used for |
|---|---|
| `whoami()` | role (athlete / trainer) and name |
| `members` | trainer's athlete list (athletes + trainers with `also_athlete`) |
| `programs` | published sessions for the athlete (or for everyone) |
| `ticks` | done sets and what was logged (kg / reps / secs) |
| `session_finishes` | finished badge (optional; ignored if the table is missing) |
| `wods`, `wod_board()`, `wod_results` | leaderboards, rankings, the athlete's scores |
| `lift_maxes` | 1RM benchmarks (written when you log or edit a 1RM) |
| `register_device_token()` | saves this phone for push (needs `supabase/009_push.sql`) |
| `log_benchmark()` | logs a benchmark with no leaderboard yet (needs `supabase/008_benchmarks.sql`) |

The benchmark list is `AthleteTracker/Resources/wods.json`, a copy of the website's `wods.json`.
Copy it again after changing the library: `cp wods.json ios/AthleteTracker/Resources/wods.json`.

Row-level security does the filtering, exactly as for the website. Connection settings live in
`AthleteTracker/Data/Config.swift` (the public publishable key, same as `config.js`).

## Project layout

The Xcode project uses a synchronised folder, so any `.swift` file added under
`AthleteTracker/` is picked up automatically. `project.yml` is kept in step for anyone using
XcodeGen, but the checked-in `.xcodeproj` is the one to open.
