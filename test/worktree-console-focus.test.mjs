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
  "band 8 with text in the prompt: the text goes on as typed and nothing is deferred",
  "band: 8 only ever defers; nothing goes into the prompt box",
  "the console's prompt hint is the engine's own: nothing is added after auto mode on, with sessions working, answered or none",
  "outside Orca, or in a session that is not the console, nothing is drawn",
  "pane footer on every tab, the empty frame too, is only the keys line, right under the last card with one blank row between and blank space below; no 執行中 or 回覆完畢",
  "cards past the pane height: the keys line scrolls with the cards, out of view until the end, then whole under the last card; every row above the end goes to cards",
  "the same pane height holds more cards than when the counts and keys were pinned under them, and more than 5-row framed cards did",
  "「狀態」 typed with mods goes on to the conversation as typed and opens nothing; the pane opens only from 0",
  "「狀態」 without mods goes on to the conversation untouched",
  "設定檔：不是中控台的分頁不讀 config.json，設定錯了也不跳提示；成為中控台後才提示一次",
  "設定檔：config.json 不是有效的 JSON 時跳一次提示並用預設外觀，重開面板不再重複",
  "設定檔：寫了 appearance（不論值）跳一次「appearance 已移除，一律用預設外觀」，外觀照常；沒寫不跳；無效 motion 也提示一次",
  "pane tabs: only 待回覆 q, 全部 w, 封存 e with counts; the open tab is lit, the rest dim; each filters as the design says",
  "全部 lists every session not archived, idle ones included with their 閒置 status; an archived one never shows there; 待回覆 keeps leaving out a pushed idle session",
  "pane footer keys read only 「qwe 切分頁 · 1-9,0/↑↓ 選卡片」, never qwer, no Enter or Esc",
  "主題：neutral-light、gruvbox、light 的邊框對底色至少 3:1",
  "主題：每個主題的選取框強調色不等於任何狀態色，gruvbox 的強調色也不等於次要文字色",
  "卡片寬度: a ticketless worktree (backend…) keeps 代號, status and stage on one row; a 代號 too long for the row is cut with … so the status tag never stacks",
  "卡片 ✓ 建議: no mark while the suggestion is being written, when it failed (no advice) or for a card with no suggestion; never the answer letter",
  "摘要浮層: d opens the chosen card's recap in a popover right under the card, drawn over the cards below without moving them; nothing opens, switches, prints or reaches the conversation; d again closes it",
  "摘要浮層: one popover at a time; ↑↓ onto another card, Esc handing the keys back to the prompt, or a tab switch closes it; d then opens the newly chosen card's",
  "摘要浮層: a session with no recap yet says 還沒有摘要; one being written says 摘要產生中…, and a newer one being written under an old recap says so under it",
  "摘要浮層: p prints the card's whole report, through /focus-show, for the band question and a queued one, and closes the popover",
  "摘要浮層捲動: the popover stops at the pane rows in view; past that j/k, the wheel and the page keys scroll its text, its bottom reads j/k 捲動 · 第 N–M 行／共 T 行, and the cards stay put",
  "摘要浮層位置: a card in the pane's lower half opens its popover above it, never over the tab rows; a card in the upper half opens it below; a short recap gets a short popover with no scroll line",
  "選中標記：面板拿到鍵盤且 motion 開著時照 · ✢ ✳ ✶ ✻ ✽ 來回轉；鍵盤交回輸入框或 motion: false 時停在 ✻，不開計時器",
  "子 session 分頁：第一行是「── 摘要 ──」分隔線，下面一層一行：標籤在固定左欄、內容從同一欄開始；▶ 要你決定整行強調色加粗，其他標籤淡色、內容前景色；每行不超寬",
  "子 session 分頁：放不下時先截短「做了什麼」（以 … 結尾），「要你決定」與「下一步」不截短、折到下一行並對齊內容欄；行數超過 4 行時先拿掉「做了什麼」",
  "子 session 分頁：摘要產生中在分隔線下只寫「產生中…」，沒有 0 鍵；產生好了下一次輪詢換成摘要",
  "子 session 分頁：還在跑、沒有摘要、或摘要屬於這個分頁之前的 session（/clear 之後）時不畫，交給引擎",
  "子 session 分頁：完整摘要的側邊面板與 0 鍵都拿掉了，按 0 不開任何面板",
  "摘要截行：照顯示欄寬折行，保留原本的換行，超過上限時最後一行以 … 結尾且不超寬",
  "子 session 分頁：舊摘要檔的舊標籤（前提、問題、解法、建議）畫成同一種排版；沒有標籤的摘要照自己的行畫在分隔線下，最多 4 行、截斷以 … 結尾",
  "摘要分層：新標籤照順序分層、第 2 行接在同一層；「卡在哪：無」整層省略；另起一行的「建議：」接回「要你決定」同一行；每層最多 2 行",
  "摘要小視窗排版：標籤是固定左欄、換行對齊內容欄；▶ 要你決定前空一行、整行強調色加粗；其他標籤淡色、內容前景色；底部分隔線下寫「d 收起 · p 印出完整回報」",
  "摘要小視窗：「下一步」用一般字色、不加 ▶、前面不空行；舊摘要檔的舊標籤（前提、問題、解法、建議）畫成同一種排版；沒有標籤的摘要照原文換行",
  "全部的 repo 分組線與它下面第一張卡之間空一行，捲動照新的列數算：分組線前空一行、線一行、卡上方空一行、卡兩行；↑↓ 選到的卡照舊完整露出，捲到底時按鍵說明也露出",
  "pane groups by repo outside 待回覆: `── <repo> ── 共 N 個` counts every session of that repo; a blank row sits above the rule and another between the rule and its first card, as above every card",
  "分頁列平均分散（三個分頁）：justifyContent space-between 排滿整行，第一個貼左、最後一個貼右；粗線落在所選分頁正下方、寬度等於標籤；不足 46 欄時沒選的只留按鍵與數字、仍是一列",
  "待回覆卡片寬度（46 欄）：每列都不超出面板寬度，代號至少留 1 欄；卡與卡之間空一行、每張仍佔 3 列",
  "待回覆卡片寬度（36 欄）：每列都不超出面板寬度，代號至少留 1 欄；卡與卡之間空一行、每張仍佔 3 列",
  "面板背景：0 開面板時要求 Claude Code 不畫面板底色（backgroundColor transparent），neutral 不另畫底色，用終端機本身的背景",
  "卡片第二行（neutral）：待回覆、全部、封存的卡片第二行左邊是 branch、右端是 repo，都用主題淡色、repo 再加 dimColor；repo 文字右端貼齊卡片右緣；第一行不放 repo；不顯示階段",
  "卡片第二行（dracula）：待回覆、全部、封存的卡片第二行左邊是 branch、右端是 repo，都用主題淡色、repo 再加 dimColor；repo 文字右端貼齊卡片右緣；第一行不放 repo；不顯示階段",
  "卡片第二行寬度：branch 與 repo 之間至少 2 格；放得下就都完整，放不下時 repo 至少留 8 格、branch 以 … 截短；沒有 branch 時 repo 可用整行",
  "待審核卡片：review > 0 的卡片狀態字換成「待審核」（待回答色），第一行右端靠右寫「需審核 N 件」；review 0 的卡片照原狀態、沒有這段；卡片仍是兩行",
  "待回覆卡片深淺：文字中只有代號是前景色粗體（選中時強調色粗體），狀態照原狀態色；題目、branch、repo 都是淡色；不顯示階段；✓ 建議照舊強調色",
  "卡片左邊留白：選中標記前多一格，沒選中的卡與第二行一起往右 1 欄；待回覆、全部、封存都一樣，repo 分組標題線不動",
  "卡片第二行在待回覆：branch 用主題淡色，不放題目、摘要或 建議：；repo 在第二行右端、不在標題列",
  "cards on 全部 and 封存 show their repo on the second row and never the stage (規劃中, 實作中, 已推送) or 建議：, at any width",
  "按鍵說明（pending）：補滿整行、文字置中，前後用 ─ 夾住、兩邊至少各 2 個；太窄時先截說明文字",
  "按鍵說明（all）：補滿整行、文字置中，前後用 ─ 夾住、兩邊至少各 2 個；太窄時先截說明文字",
  "按鍵說明（hidden）：補滿整行、文字置中，前後用 ─ 夾住、兩邊至少各 2 個；太窄時先截說明文字",
  "階段字（規劃中、實作中、已推送、未開工）在待回覆、全部、封存的卡片上都不畫，任何寬度都一樣；repo 在卡片第二行右端",
  "卡片 ✓ 建議: a card whose suggestion is ready reads ✓ (accent) 建議 (dim) at the right end of its header, before 需審核 N 件 when it has one, on 待回覆 and 全部 alike; below 46 columns only ✓; the header stays one row",
  "審核單：review > 0 的卡片按 Enter（點代號）開審核單畫面、跑 review data --json，不切換橫條；數字鍵也一樣",
  "審核單畫面（70 欄）：沒有說明句和警告；標題、branch · PR 與靠右的 repo、先看：沒有前例每件四行、照你過去的回答每件兩行（出處括號）、底下按鍵說明",
  "審核單畫面（46 欄）：每行都不超出面板；題目以 … 截短，方案、依據換行時對齊內容欄；按鍵說明在按鍵之間換行",
  "審核單 Enter：通過選中的那件（review pass），那件收成一行「✓ N. 題目」，選取跳到下一件待審的",
  "審核單 ↑↓：一次移一件，停在第一件與最後一件；Enter 作用在選中的那件",
  "審核單 e：那件底下開「改成」輸入框，Enter 送 review edit --to，那件標「已改」並顯示新方案；Esc 只收起輸入框，不改、不離開審核單",
  "審核單 x：開「問」輸入框（提示「空白直接按 Enter＝要一個實際範例」）；空白送出要範例（review ask 不帶 --q），有字就帶 --q；答案插在那件底下，問答在背景跑、跑完才重畫",
  "審核單 o：那件有範例檔時按鍵說明才有「o 開範例」，按 o 用 open 開範例檔；沒有範例時 o 什麼都不做",
  "審核單 c：把選中那件的題目、當前方案、依據、影響範圍送進中控台對話討論；畫面不變",
  "審核單 a：選取在「先看：沒有前例」時按鍵說明沒有 a、按 a 不做事；移到「照你過去的回答」才有「a 全部通過」，按下跑 review pass-all，只通過那一段",
  "審核單收尾：每件都通過或改過後停在「全部審完，按 Enter 送出審核結果」（還能按 u 退回），按 Enter 才跑 review done，跳出它印的結果，回到卡片並重新輪詢；卡片不再是待審核",
  "審核單 Esc：沒開輸入框時回到卡片；進度存在磁碟上，再開同一張審核單時已通過的那件仍是 ✓",
  "審核單捲動：面板放不下時只畫看得到的列，選中的那件整件露出，按鍵說明留在最下面",
  "審核單畫面範例（70 欄）：一開始的畫面，與通過第 1 件、在第 2 件問一題之後的畫面；每行都不超出面板",
  "審核單畫面範例（46 欄）：一開始的畫面，與通過第 1 件、在第 2 件問一題之後的畫面；每行都不超出面板",
  "cards on 待回覆, 全部 (idle ones too) and 封存: no frame, two rows and a blank row above; no question text at any width; the second holds the branch; options never show",
  "cards: number (none on the question on screen) and nickname button, status icon and word on the first row, never the question; branch and repo on the second; no stage on any tab, no options, never 建議; no frame and no rail: the status colour sits on the status icon, the chosen card leads with an accent ✻ mark and its name in the accent",
  "refined：上下選卡、Enter 或點暱稱都只選中卡片，不切換狀態區上的題目、不印題目；d 才開摘要小視窗",
  "the pane follows the band while it is open: a defer or a new stop on the band reorders 待回覆 at once",
  "不主動跳題：目前這件換人（換題、回完輪到下一件）時不送 /focus-show、不跳浮動通知；別的 session 有新題也不跳「進排隊」通知",
  "卡片代號（all）：代號太長時以 … 截短，標題列不畫題目、永遠一行、不超出面板",
  "卡片代號（hidden）：代號太長時以 … 截短，標題列不畫題目、永遠一行、不超出面板",
  "卡片代號（pending）：代號太長時以 … 截短，標題列不畫題目、永遠一行、不超出面板",
  "拿掉切題：待回覆分頁按數字、Enter 或點暱稱只選中卡片，不跑 focus-pick、不換橫條上的題目、不印題目；d 再按印出完整回報才印",
  "每次輪詢都帶 --typing 與 --turn：輸入框有字時 --typing 1、中控台這一輪在跑時 --turn 1（伺服器這時不換目前這件），子 agent 的回合不算",
  "狀態區只有 8、9、0 三個鍵：排隊再多，1–7 都不是狀態區的鍵，輸入框空白時照常打進輸入框、不換題",
  "狀態區按鍵：8 跑 focus-later、9 印目前這件、0 開面板；1–5 不是狀態區的鍵（輸入框空白時照常打字）",
  "狀態區：放不下時畫腳本給的下一種寫法（第一種放得下的），都放不下時把最後一種以 … 截短；不另起一行、不超出寬度",
  "狀態區：照方案 D 畫腳本給的每一行——◆ 輪到你 加代號、建議、分組；按鍵行是 8 延後處理   9 顯示問題   0 面板（數字粗體、說明暗色、隔三格）；不畫題目",
  "狀態區：等某個 session 回應時第一行是 ◌ 等 <代號> 回應中…（代號粗體），有別題在等時右邊是 8 先處理下一件   0 面板；什麼都沒有時不畫狀態區",
  "審核單欄位標籤（neutral）：當前方案、依據、影響範圍用主題最淡的灰（dim 色再加 dimColor），比一般淡色字（branch 那行）更淡；內容用前景色",
  "審核單欄位標籤（dracula）：當前方案、依據、影響範圍用主題最淡的灰（dim 色再加 dimColor），比一般淡色字（branch 那行）更淡；內容用前景色",
]) {
  test(`focus pane mod test passes: ${name}`, () => {
    assert.ok(out.includes(`(pass) ${name}`), out);
  });
}
