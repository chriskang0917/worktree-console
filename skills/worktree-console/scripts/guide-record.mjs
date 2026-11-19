// What `console.mjs guide` last printed: per session the console's own advice and split for that stop, and the ending lines of the
// console's newest run, which its Stop hook compares with the reply.
import fs from "node:fs";
import path from "node:path";
import { consoleHome as home } from "./lib.mjs";

const FILE = "guide.json";

export function readGuide(dir = home()) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8"));
    return { sessions: value.sessions ?? {}, last: value.last ?? null };
  } catch {
    return { sessions: {}, last: null };
  }
}

export function writeGuide(value, dir = home()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch {}
}

// The session's record while it is for this very stop; a later stop makes it stale.
export function guideFor(record, entry) {
  const r = entry?.paneKey ? record.sessions[entry.paneKey] : null;
  return r && (r.since ?? null) === (entry.since ?? null) ? r : null;
}
