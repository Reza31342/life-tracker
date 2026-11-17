# Life Tracker

A small offline-first web app for a daily log, tasks, and weekly picks. The data lives in one private Google Sheet.
Plain HTML, CSS and JavaScript with no build step, so GitHub Pages can serve it directly.

## Run locally

    python3 -m http.server 8080

Then open http://localhost:8080. Run the tests with `npm test` (Node 18+).

## Files

- `index.html`, `styles.css`, `app.js`: the app shell and screens (Home, Tasks, Picks, Trends, Settings).
- `schema.js`: the sheet layout (tabs, columns, types), row encoding, and the Berlin logical day.
- `store.js`: device data: the last copy read from the sheet, a queue of changes not yet written, and the v1 migration.
- `sheets.js`: Google Sheets API calls (read all tabs, update rows, append rows) with retries.
- `auth.js`: Google sign-in (Identity Services). The token is kept in memory only.
- `sync.js`: the sync rules (last write wins per row, header check, no-op detection).
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline cache and home-screen install.

## Connect to the Google Sheet (once)

1. In Google Cloud Console, create a project and enable the **Google Sheets API**.
2. Under Google Auth Platform, set the audience to External, leave it in Testing, and add your own Google account as a test user.
3. Under Clients, create an **OAuth client ID** of type Web application. Add these Authorized JavaScript origins:
   - `https://reza31342.github.io`
   - `http://localhost:8080` (only for local testing)
4. Open the app's Settings, paste the client ID and the Sheet ID (the long id in the sheet's link), then press **Save and connect**.

The client ID and Sheet ID are stored on the device only. The repo holds no IDs, tokens, or personal data.

## Sync behaviour

- Every edit is saved on the device first, so the app works offline. The status in the header shows what is waiting.
- Sync runs after edits, when you come back online, every five minutes, and on Sync now.
- If two devices change the same row, the newer change wins. The older edit is dropped and the app says so.
- If someone renames or moves a column in the sheet, sync stops with a message instead of writing to the wrong column.
- The first time, the app moves any data from the earlier local version (`life-tracker.v1`) into the outbox. That key is left in place.
