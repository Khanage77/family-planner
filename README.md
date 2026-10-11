# Khan Family Planner

The family week, shared live between Ridwaan's and Shamilla's phones. Installs as an app, works offline, and syncs when back online.

- Data: Supabase project `khan-family-planner` (London), table `docs`, locked to the two family emails.
- Hosting: GitHub Pages, `https://khanage77.github.io/family-planner/`

## Files

| File | What it is |
|---|---|
| `index.html` | The planner |
| `sync.js` | Connects the planner to Supabase, keeps an offline copy, queues offline changes |
| `supabase.js` | Supabase browser library (v2.117.3), stored locally so the app opens offline |
| `manifest.webmanifest`, `sw.js`, `icons/` | Make it installable and offline-capable |
| `setup.sql` | One-time database setup. Runs in Supabase, **not** uploaded to GitHub |

## Logins

Logins are created in Supabase → **Authentication → Users → Add user → Create new user** (tick **Auto Confirm User**).
To reset a password: same page → click the user → **Reset password** / set a new one.

## Adding another person

1. Add their email to `ALLOWED` near the top of the planner script in `index.html`.
2. Add it to both lists in the policy in `setup.sql` and run that block again in the SQL Editor.
3. Create their login (above).

## Updating the app

Upload the changed files to the GitHub repo, and bump `CACHE` in `sw.js` (e.g. `kfp-v2`). Phones pick up the new version on their next open.
