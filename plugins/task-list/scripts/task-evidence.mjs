import fs from "node:fs";
import path from "node:path";
import { taskPath, fail } from "./task-store.mjs";

const CONTROL_FILES = ["task-state.json", "README.md", "board.md"];

export const isRemoteEvidence = ref => /^[a-z][a-z0-9+.-]*:\/\//i.test(ref);

function entryExists(file) {
  try { return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined; }
  catch (error) {
    // A name the filesystem cannot hold (too long, NUL) is text, not a file.
    if (["ENOENT", "ENOTDIR", "ENAMETOOLONG", "ERR_INVALID_ARG_VALUE"].includes(error.code)) return false;
    throw error;
  }
}

/**
 * The one decision for whether a reference names a file close would move.
 * Returns null for evidence that stays as written (URL, text, missing file, already archived);
 * throws UNSAFE_PATH or UNSAFE_ARCHIVE for an existing entry that can never be archived.
 */
export function archivableEvidence(root, ref) {
  if (isRemoteEvidence(ref)) return null;
  const realRoot = fs.realpathSync.native(root);
  if (!entryExists(path.resolve(realRoot, ref))) return null;
  const file = taskPath(root, ref);
  // The on-disk spelling, so a case-insensitive filesystem cannot alias a protected path and a case-sensitive one keeps distinct names distinct.
  const real = path.relative(realRoot, fs.realpathSync.native(file));
  if (real === "history" || real.startsWith("history/")) return null;
  const configFile = taskPath(root, ".console/config.json");
  const boardPath = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")).boardPath : undefined;
  const boardFile = typeof boardPath === "string" && entryExists(path.resolve(realRoot, boardPath)) ? taskPath(root, boardPath) : null;
  const board = boardFile && path.relative(realRoot, fs.realpathSync.native(boardFile));
  if (CONTROL_FILES.includes(real) || real === ".console" || real.startsWith(".console/") || real === board) fail("UNSAFE_ARCHIVE", "證據不可搬移任務控制檔或生成看板");
  if (!fs.statSync(file).isFile()) fail("UNSAFE_ARCHIVE", "證據必須是檔案");
  return file;
}
