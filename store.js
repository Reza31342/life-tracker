// Local data layer. Shapes mirror the Google Sheet tabs in the spec:
// tasks, days, cigs (one row per tap), screentime, picks, settings.
const KEY = 'life-tracker.v1';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const samplePicks = (now) => [
  { id: 'sample-paper', kind: 'paper', title: 'Sample paper (import your picks in Settings)', source: 'sample', meta: '', url: '', why: 'Replace these samples with the weekly picks.', rank: 1, week: '2026-W47', status: 'active', date: '', deadline: '', createdAt: now },
  { id: 'sample-event', kind: 'event', title: 'Sample event', source: 'sample', meta: '', url: '', why: '', rank: 2, week: '2026-W47', status: 'active', date: '2026-12-02', deadline: '', createdAt: now },
  { id: 'sample-job', kind: 'job', title: 'Sample job posting', source: 'sample', meta: '', url: '', why: '', rank: 3, week: '2026-W47', status: 'active', date: '', deadline: '2026-12-10', createdAt: now },
];

export function defaults() {
  const now = new Date().toISOString();
  return {
    tasks: [],
    days: {},
    cigs: [],
    screentime: [],
    picks: samplePicks(now),
    settings: { sheetId: '', profile: '', lastRun: null },
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults(), ...JSON.parse(raw) };
  } catch (err) {
    console.warn('Could not read saved data', err);
  }
  return defaults();
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not save data', err);
  }
}
