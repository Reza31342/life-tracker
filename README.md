# Life Tracker

A small offline-first web app for a daily log, tasks, and weekly picks.
Plain HTML, CSS and JavaScript with no build step, so GitHub Pages can serve it directly.

## Run locally

    python3 -m http.server 8080

Then open http://localhost:8080.

## Files

- `index.html`, `styles.css`, `app.js`: the app shell and screens (Today, Tasks, Picks, Settings).
- `store.js`: local data layer. Its shapes mirror the planned Google Sheet tabs.
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline cache and home-screen install.

## Status

- Data is stored in the browser for now. Google sign-in and Sheets sync are not connected yet.
- The repo holds code only: no tokens, no sheet ID, no personal data.
