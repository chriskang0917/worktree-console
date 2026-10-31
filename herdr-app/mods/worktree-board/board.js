// What the board shows, from the console's state file alone: no status of its own.
export const ICONS = { anomaly: "⚠️", permission: "🔐", waiting: "💬", busy: "🔄", done: "⏸", idle: "💤" };
// Sessions that need the person come first.
export const ORDER = ["anomaly", "permission", "waiting", "busy", "done", "idle"];
export const STALE_MS = 2 * 60 * 1000;

const rank = (kind) => {
  const i = ORDER.indexOf(kind);
  return i < 0 ? ORDER.length : i;
};

const pad = (n) => String(n).padStart(2, "0");

export function clock(at) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function waited(since, now) {
  if (typeof since !== "number") return "";
  const m = Math.max(0, Math.floor((now - since) / 60000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Rows by urgency, the longest wait first within one state, then grouped by repo: a repo's group sits where its most
// urgent row would, so whoever needs the person stays on top. `stale` once the console stopped writing.
export function boardView(state, now) {
  const rows = (Array.isArray(state?.rows) ? state.rows : [])
    .map((r) => ({
      repo: r.repo ?? "",
      tag: r.tag,
      terminal: r.terminal,
      kind: r.kind,
      icon: ICONS[r.kind] ?? "·",
      wait: waited(r.since, now),
      since: r.since,
      stage: r.stage ?? "",
      activity: r.activity && r.activity !== "—" ? r.activity : "",
    }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || (a.since ?? now) - (b.since ?? now));
  const groups = [];
  for (const r of rows) {
    const g = groups.find((x) => x.repo === r.repo);
    if (g) g.rows.push(r);
    else groups.push({ repo: r.repo, rows: [r] });
  }
  const flat = groups.flatMap((g) => g.rows);
  if (typeof state?.at !== "number") return { rows: flat, groups, stale: true, note: "中控台還沒寫入資料" };
  const stale = now - state.at > STALE_MS;
  return { rows: flat, groups, stale, note: stale ? `中控台未在執行，資料停在 ${clock(state.at)}` : null };
}

export function parseState(text) {
  try {
    const value = JSON.parse(text ?? "");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
