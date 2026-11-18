import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const handoff = fs.readFileSync(path.join(root, "skills/worktree-console/references/handoff.md"), "utf8");

test("handoff.md 的 /goal 開頭句讓 ⚠️ 條目不擋收工，並要求另列待你判定", () => {
  const match = handoff.match(/開頭：`(本次任務依 <[^>]+> 執行：[^`]*)`/);
  assert.ok(match, "handoff.md 找不到 /goal 開頭句");
  assert.ok(
    match[1].includes("逐條滿足其中全部驗收準則；標 ⚠️ 需人工判定的不用等使用者、不算未完成，收工回報另列「待你判定：第 N 條」。"),
    "handoff.md 開頭句缺少 ⚠️ 例外字句",
  );
});

test("handoff.md 的 /goal 開頭句以〈停點〉句收尾，不再要 commit、push 等使用者指示", () => {
  const opening = handoff.match(/開頭：`(本次任務依 <[^>]+> 執行：[^`]*)`/)[1];
  assert.ok(
    opening.endsWith("不要動主 checkout 的檔案。照 ~/.claude/CLAUDE.md〈停點〉：五個條件都成立就直接做到 draft MR，任一條不成立就停下問；需人工判定的列進 MR「請先看」。"),
    "開頭句沒有以〈停點〉句接在「不要動主 checkout 的檔案。」之後收尾",
  );
  assert.ok(!opening.includes("commit、push 照使用者後續指示"), "開頭句還留著舊句");
});
