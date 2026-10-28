import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync("claude", ["plugin", "test", root], { cwd: root, encoding: "utf8" });
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;

test("claude plugin test runs every mod test and none fail", () => {
  assert.equal(run.error, undefined, "claude CLI is needed to run the mod tests");
  assert.equal(run.status, 0, out);
});

for (const name of [
  "empty pane: every tab says 目前沒有符合條件的 session, never a bare 目前沒有",
  "empty pane: a round frame as wide as the pane, a blank line above and below grey text, 5 rows tall",
  "empty pane: the text sits in the middle of the frame at 80 and 144 columns, the two sides at most one column apart",
  "empty pane: the frame takes the theme border colour, never the chosen card accent",
  "band header: status icon, status word and 代號 on the left, 8 延後處理 · 9 顯示問題 on the right in the dim colour; the whole question; 0 面板 and queue 1–5 below",
  "band header: an empty queue leaves only 9 顯示問題, still on the right; the old row of buttons is gone and its row goes to the question",
  "band header at 40 columns: a long 代號 is cut with …, both buttons stay whole, and the header is one row",
  "band: the queue shows at most 5 (1–5) and a new one is marked ✨; nothing sits on 6 or 7; 8 延後處理 only while the queue has one",
  "band keys: 1–5 switch to that question and print it, 8 (延後處理) sends it behind the queue and prints the next, 9 (顯示問題) prints the one on screen, 0 opens the pane with the keyboard",
  "the pane follows the band while it is open: a switch, a defer or a new question on the band reorders 待回覆 at once",
  "band 8 with text in the prompt: the text goes on as typed and nothing is deferred",
  "band: 8 only ever defers; nothing goes into the prompt box",
  "the console's prompt hint ends with 「工作中 N · 已回覆 M」 after auto mode on: archived not counted, zeros written, kept fresh by the poll",
  "outside Orca, or in a session that is not the console, nothing is drawn",
  "pane footer on every tab, the empty frame too, is only the keys line, right under the last card with one blank row between and blank space below; no 執行中 or 回覆完畢",
  "cards past the pane height: the keys line scrolls with the cards, out of view until the end, then whole under the last card; every row above the end goes to cards",
  "the same pane height holds more cards than when the counts and keys were pinned under them",
  "「狀態」 typed with mods goes on to the conversation as typed and opens nothing; the pane opens only from 0",
  "「狀態」 without mods goes on to the conversation untouched",
  "設定檔：不是中控台的分頁不讀 config.json，設定錯了也不跳提示；成為中控台後才提示一次",
  "設定檔：config.json 不是有效的 JSON 時跳一次提示並用預設外觀，重開面板不再重複",
  "設定檔：寫了 appearance（不論值）跳一次「appearance 已移除，一律用預設外觀」，外觀照常；沒寫不跳；無效 motion 也提示一次",
  "pane tabs: only 待回覆 q, 全部 w, 封存 e with counts; the open tab is lit, the rest dim; each filters as the design says",
  "全部 lists every session not archived, idle ones included with their 閒置 status; an archived one never shows there; 待回覆 keeps leaving out a pushed idle session",
  "pane footer keys read only 「qwe 切分頁 · 1-9,0/↑↓ 選卡片」, never qwer, no Enter or Esc",
  "寬度：✨ 算 2 欄，排隊名稱後的 ✨ 照 2 欄預留",
  "主題：neutral-light、gruvbox、light 的邊框對底色至少 3:1",
  "主題：每個主題的選取框強調色不等於任何狀態色，gruvbox 的強調色也不等於次要文字色",
  "an announce is printed once though polls repeat it, then reported with focus-shown; the poll carries the session id",
  "漏印重送: a /focus-show the console drops (it answers without the report) is not reported as shown and goes again on the next poll; printed once, then focus-shown once",
  "漏印重送: three misses in a row toast 「[perm] 題目沒印出，按 9 印」 once; it keeps trying and prints once the console takes it",
  "漏印重送: after the toast, Enter on the card and 印出完整回報 print the question and reports it shown, so the next poll does not print it again",
  "漏印重送: a rejected /focus-show is never reported as shown; it is tried every poll and after 3 tries the toast says focus-show is missing",
  "漏印重送: 回完答案後 60 秒內同一 session 又出題 while the console is still on its turn; /focus-show <代號> <編號> of the new stop is sent again and printed once",
  "卡片寬度: the bottom right is cut at 20 columns ending in …; 專案檢視介面調整建議 (exactly 20) is shown whole",
  "卡片寬度: on 待回覆 the repo takes what the bottom right leaves, 2 columns apart, cut with …, gone under 4 columns; a narrow pane cuts the bottom right too; the bottom is one row at every width",
  "卡片寬度: a ticketless worktree (backend…) keeps 代號, status and stage on one row; a 代號 too long for the row is cut with … so the status tag never stacks",
  "卡片 ✓ 建議: a card whose suggestion is ready reads ✓ (accent) 建議 (dim) on its header right, before the stage; below 46 columns only ✓; the header stays one row",
  "卡片 ✓ 建議: no mark while the suggestion is being written, when it failed (no advice) or for a card with no suggestion; never the answer letter",
  "摘要小面板: Enter on a card (or a click on its nickname) opens that session's recap in a dialog with the keyboard that Esc closes; nothing is printed or sent to the conversation",
  "摘要小面板: a session with no recap yet says 還沒有摘要; one being written says 摘要產生中…, and a newer one being written under an old recap says so under it",
  "摘要小面板: 印出完整回報 closes the dialog and prints exactly the report Enter used to print, through /focus-show, for the band question and a queued one",
  "子 session 分頁：停下後輸入框上方是「摘要」前綴（強調色）加摘要，續行對齊在文字下；最多 4 行，超過時最後一行以 … 結尾；沒有分隔線",
  "子 session 分頁：短摘要整段照畫、不加 …，下面一行是 0: 完整摘要",
  "子 session 分頁：摘要產生中只寫「產生中…」，沒有 0 鍵；產生好了下一次輪詢換成摘要",
  "子 session 分頁：還在跑、沒有摘要、或摘要屬於這個分頁之前的 session（/clear 之後）時不畫，交給引擎",
  "子 session 分頁：輸入框空白時按 0 開側邊面板，面板顯示完整摘要不截短；沒有摘要時寫「還沒有摘要」",
  "摘要截行：照顯示欄寬折行，保留原本的換行，超過上限時最後一行以 … 結尾且不超寬",
]) {
  test(`focus pane mod test passes: ${name}`, () => {
    assert.ok(out.includes(`(pass) ${name}`), out);
  });
}
