// Undo history for changes made in this app. Each entry is one user action and keeps what the
// changed rows looked like before (null for a row the action created). Undoing writes those
// versions back as new edits, so the undo also wins on the sheet. History lasts until a reload.
export class UndoHistory {
  constructor({ limit = 40, mergeMs = 5000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.mergeMs = mergeMs;
    this.now = now;
    this.entries = [];
    this.open = null;
  }

  get size() { return this.entries.length; }
  get last() { return this.entries[this.entries.length - 1] || null; }

  // Groups every change made inside fn into one entry, e.g. a task made from a pick.
  group(label, fn) {
    if (this.open) return fn();
    this.open = { label, items: [], at: this.now() };
    try {
      return fn();
    } finally {
      const e = this.open;
      this.open = null;
      if (e.items.length) this.push(e);
    }
  }

  // Records one changed row. Repeated edits of the same row with the same label within mergeMs
  // (typing in today's log) become one entry that goes back to the first version.
  record(label, tab, key, before) {
    const item = { tab, key, before: before ? structuredClone(before) : null };
    if (this.open) {
      if (!this.open.items.some((i) => i.tab === tab && i.key === key)) this.open.items.push(item);
      return;
    }
    const top = this.last;
    const t = this.now();
    if (top && !top.sealed && top.label === label && top.items.length === 1 && top.items[0].tab === tab
      && top.items[0].key === key && t - top.at <= this.mergeMs) {
      top.at = t;
      return;
    }
    this.push({ label, items: [item], at: t });
  }

  // Ends merging into the last step, e.g. when the user moves to another day.
  seal() {
    if (this.last) this.last.sealed = true;
  }

  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  pop() {
    return this.entries.pop() || null;
  }
}
