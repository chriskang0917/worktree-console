// The ending line the opening rules ask every child stop to end with, shared by the Stop hook that asks for it and the board that reads it.
import fs from "node:fs";
import path from "node:path";

const ENDING_WAIT = /^[\s*_-]*等你[:：]\s*(.*?)[\s*_]*$/;
// 「不用等你」 is the old wording; sessions opened before the rename still end with it.
const ENDING_FREE = /^[\s*_-]*(?:已完成[\s*_。.!！]*$|不用等你)/;

export const lastLine = (text) => (String(text ?? "").replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim()).at(-1) ?? "").trim();

// { wait: true, what } for 「等你：…」, { wait: false } for 「已完成」, null when the stop's last line is neither.
export function endingOf(text) {
  const last = lastLine(text);
  const wait = last.match(ENDING_WAIT);
  if (wait) return { wait: true, what: wait[1] };
  return ENDING_FREE.test(last) ? { wait: false, what: null } : null;
}

const missedFile = (home, handle) => path.join(home, "no-ending", `${encodeURIComponent(handle)}.json`);

// The Stop hook asked once for the ending line and the session stopped again without it.
export function markMissed(home, handle, text) {
  try {
    fs.mkdirSync(path.dirname(missedFile(home, handle)), { recursive: true });
    fs.writeFileSync(missedFile(home, handle), JSON.stringify({ at: Date.now(), tail: lastLine(text) }));
  } catch {}
}

// That stop is still the one on screen: its last line is the one the Stop hook let through.
export function missedEnding(home, handle, text) {
  if (!handle) return false;
  try {
    const rec = JSON.parse(fs.readFileSync(missedFile(home, handle), "utf8"));
    return !!rec?.tail && rec.tail === lastLine(text);
  } catch {
    return false;
  }
}
