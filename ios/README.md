# Training Log for iPhone

A SwiftUI app that signs in with the same Supabase accounts as the website and shows the
signed-in athlete's published sessions (read-only for now). A trainer can switch athletes
from the person menu, the same way as the website's athlete picker.

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

Row-level security does the filtering, exactly as for the website. Connection settings live in
`AthleteTracker/Data/Config.swift` (the public publishable key, same as `config.js`).

## Project layout

The Xcode project uses a synchronised folder, so any `.swift` file added under
`AthleteTracker/` is picked up automatically. `project.yml` is kept in step for anyone using
XcodeGen, but the checked-in `.xcodeproj` is the one to open.
