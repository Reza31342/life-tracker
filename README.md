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
- `bridge.js`: the app's link to the sheet script, with retries.
- `sync.js`: the sync rules (last write wins per row, header check, no-op detection).
- `apps-script/Code.gs`: the script that lives inside the sheet and is the app's only way in.
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline cache and home-screen install.

## Connect to the Google Sheet

Once per sheet:

1. Open the sheet, then **Extensions > Apps Script**.
2. Delete the code in the editor, paste the contents of `apps-script/Code.gs`, and save.
3. In the toolbar, pick the function **setup** and press **Run**. Google asks for access: choose your account. On "Google hasn't verified this app", press **Advanced**, then **Go to … (unsafe)**, then **Allow**. This is your own script.
4. The execution log shows your key. Copy it and keep it private.
5. **Deploy > New deployment**. Type: **Web app**. Execute as: **Me**. Who has access: **Anyone**. Press **Deploy** and copy the web app URL (it ends with `/exec`).

Once per device: open the app, go to Settings, paste the link and the key, and press **Save and connect**.

How it is kept private:

- The link and the key are stored on the device only. The repo holds no links, keys, IDs or personal data.
- Every request must carry the key. Without it the script answers with an error and no data.
- The script can only open this one spreadsheet (`@OnlyCurrentDoc`), and only the app's tabs.
- To lock out every device (for example a lost phone), run **setup** again. It makes a new key, and the old one stops working. Then paste the new key on your own devices.
- After changing `Code.gs`: **Deploy > Manage deployments**, edit the deployment, choose **New version**, and deploy. The link stays the same.

## Sync behaviour

- Every edit is saved on the device first, so the app works offline. The status in the header shows what is waiting.
- Sync runs after edits, when you come back online, when you return to the app, every five minutes, and on Sync now.
- If two devices change the same row, the newer change wins. The older edit is dropped and the app says so.
- New rows go directly under the last row that has an id, whatever else is lower down in the sheet.
- If someone renames or moves a column in the sheet, sync stops with a message instead of writing to the wrong column.
- The first time, the app moves any data from the earlier local version (`life-tracker.v1`) into the outbox. That key is left in place.
