import "./fixtures/isolate-env.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
const HOOK = path.join(root, "hooks", "review-gate.mjs");

let tmp;
let n = 0;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review-")));
  process.env.WORKTREE_CONSOLE_LOG_DIR = path.join(tmp, "log");
  process.env.WORKTREE_CONSOLE_HOME = path.join(tmp, "home");
  process.env.AUTO_HANDOFF_HOME = path.join(tmp, "handoff");
  process.env.WORKTREE_CONSOLE_PR = "";
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const review = await import("../skills/worktree-console/scripts/review.mjs");
const gate = await import("../hooks/review-gate.mjs");

function repo(branch = "feat/demo-card") {
  const dir = path.join(tmp, `repo${++n}`);
  fs.mkdirSync(dir);
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", branch);
  fs.writeFileSync(path.join(dir, "app.js"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git };
}

const env = () => ({ ...process.env });
const cli = (cwd, ...args) => spawnSync(process.execPath, [CONSOLE, "review", ...args], { cwd, encoding: "utf8", env: env() });
const good = ["--question", "卡片進度條在 46 欄時要先讓出什麼？", "--plan", "先縮短進度條。", "--basis", "沒有前例", "--impact", "焦點面板的卡片第一行。", "--by", "advisor", "--stop", "規劃 第 3 題"];
const add = (cwd, extra = []) => cli(cwd, "add", ...good, ...extra);

test("review add 寫進 reviews/<repo>/<branch>/review.jsonl，欄位齊全；狀態變更另寫一行、不改舊行", () => {
  const { dir } = repo();
  const r = add(dir, ["--session", "s1", "--ticket", "SARA-1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已記下審核第 1 件/);
  const file = path.join(tmp, "log", "reviews", path.basename(dir), "feat", "demo-card", "review.jsonl");
  const first = fs.readFileSync(file, "utf8");
  const line = JSON.parse(first);
  for (const k of ["n", "at", "repo", "branch", "ticket", "path", "session", "question", "plan", "basis", "impact", "by", "stop"]) assert.ok(k in line, k);
  assert.deepEqual([line.n, line.repo, line.branch, line.ticket, line.session, line.by, line.basis.kind], [1, path.basename(dir), "feat/demo-card", "SARA-1", "s1", "advisor", "none"]);
  assert.equal(cli(dir, "pass", "--n", "1").status, 0);
  assert.equal(cli(dir, "edit", "--n", "1", "--to", "改用實線").status, 0);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.startsWith(first), "舊行沒被改");
  assert.deepEqual(after.trim().split("\n").map((l) => JSON.parse(l).event), ["add", "pass", "edit"]);
});

test("有前例的代回記下出處；誰代回只收 advisor 或 child", () => {
  const { dir } = repo();
  assert.equal(cli(dir, "add", "--question", "測試補到哪一層？", "--plan", "補在元件層", "--source", "11/10 你的回答", "--impact", "測試", "--by", "child", "--stop", "x").status, 0);
  const st = review.stateOf(review.worktreeOf(dir));
  assert.deepEqual(st.open[0].basis, { kind: "precedent", source: "11/10 你的回答" });
  const bad = cli(dir, "add", ...good.slice(0, 8), "--by", "someone", "--stop", "x");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /「誰代回」不合格/);
});

test("branch 中途改名，review sheet 仍列出改名前的代回（以 worktree 路徑＋編號對應）", () => {
  const { dir, git } = repo("feat/old-name");
  assert.equal(add(dir).status, 0);
  git("branch", "-m", "feat/new-name");
  assert.equal(cli(dir, "add", ...good.slice(0, 1), "改名後的題目？", ...good.slice(2)).status, 0);
  const out = cli(dir, "sheet").stdout;
  assert.match(out, /1\. 卡片進度條/);
  assert.match(out, /2\. 改名後的題目/);
  assert.match(out.split("\n")[1], /^feat\/new-name/);
});

test("審核單格式：第一行審核單：代號、第二行左 branch（接 PR）右 repo、只有兩區、四行與兩行、沒有說明句與提醒", () => {
  const { dir } = repo("feat/demo-card");
  add(dir);
  cli(dir, "add", "--question", "commit 要拆幾個？", "--plan", "功能和升版分開", "--source", "AGENTS.md", "--impact", "commit", "--by", "advisor", "--stop", "x");
  const r = spawnSync(process.execPath, [CONSOLE, "review", "sheet"], { cwd: dir, encoding: "utf8", env: { ...env(), WORKTREE_CONSOLE_PR: "PR #52" } });
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "審核單：demo-card");
  assert.match(lines[1], /^feat\/demo-card · PR #52 {2,}repo\d+$/);
  assert.equal([...lines[1]].length, 70);
  assert.deepEqual(lines.filter((l) => /^\S/.test(l) && !/^\d+\./.test(l)).slice(2), ["先看：沒有前例", "照你過去的回答"]);
  const fresh = lines.slice(lines.indexOf("先看：沒有前例") + 2, lines.indexOf("照你過去的回答") - 1);
  assert.equal(fresh.length, 4);
  assert.match(fresh[1], /^ {3}當前方案/);
  assert.match(fresh[2], /^ {3}依據/);
  assert.match(fresh[3], /^ {3}影響範圍/);
  const past = lines.slice(lines.indexOf("照你過去的回答") + 2);
  assert.equal(past.length, 2);
  assert.match(past[1], /當前方案.*功能和升版分開（出處：AGENTS\.md）/);
  assert.doesNotMatch(r.stdout, /猜得太多|以下是|請審核/);
});

test("格式檢查：缺欄位、說明句超過 40 字、程式碼區塊與行內程式碼以外的程式碼，review add 當場拒寫並印哪一件哪一欄", () => {
  const { dir } = repo();
  const long = "這".repeat(41);
  const r = cli(dir, "add", "--question", "題目？", "--plan", long, "--basis", "沒有前例", "--impact", "呼叫 save(x) 寫入", "--by", "child", "--stop", "x");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /第 1 件「當前方案」不合格：說明句超過 40 字/);
  assert.match(r.stderr, /第 1 件「影響範圍」不合格：出現行內程式碼以外的程式碼/);
  const block = cli(dir, "add", "--question", "題目？", "--plan", "```js\nx\n```", "--impact", "一", "--by", "child", "--stop", "x");
  assert.match(block.stderr, /「當前方案」不合格：出現程式碼區塊/);
  assert.match(block.stderr, /「依據」不合格：缺欄位/);
  assert.equal(cli(dir, "add", "--question", "題目？", "--plan", "改 `save()` 的參數", "--basis", "沒有前例", "--impact", "一", "--by", "child", "--stop", "x").status, 0, "行內程式碼可以");
  assert.equal(fs.readFileSync(review.reviewFile(path.basename(dir), "feat/demo-card"), "utf8").trim().split("\n").length, 1);
});

test("審核單產生前檢查：舊紀錄不合格就拒絕產生並印哪一件哪一欄；寫一行更正就能產生", () => {
  const { dir } = repo();
  const wt = review.worktreeOf(dir);
  review.append(wt, { event: "add", n: 1, question: "舊題目？", plan: "x".repeat(50), basis: { kind: "none", note: "" }, impact: "", by: "advisor", stop: "x" });
  const r = cli(dir, "sheet");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /第 1 件「當前方案」不合格：說明句超過 40 字/);
  assert.match(r.stderr, /第 1 件「影響範圍」不合格：缺欄位/);
  assert.equal(cli(dir, "correct", "--n", "1", "--plan", "短的方案", "--impact", "卡片").status, 0);
  const ok = cli(dir, "sheet");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /當前方案　短的方案/);
});

const pre = (dir, tool_input, extra = {}) => gate.preToolUse({ tool_name: "Bash", tool_input, cwd: dir, session_id: "child-1", tool_use_id: `t${++n}`, ...extra }, { consoleCheck: () => false });
const blocked = (out) => out?.hookSpecificOutput?.permissionDecision === "deny";

test("四個攔截點：有待審代回時擋下並印先跑 review sheet；沒有待審代回時照常放行", () => {
  const { dir } = repo();
  const calls = [
    { tool_input: { command: 'node "$FLOW" approve --auto' } },
    { tool_input: { command: 'node "$FLOW" approve --user-said "好"' } },
    { tool_input: { command: 'python3 "$FLOW" confirm-spec' } },
    { tool_input: { command: "node /x/skills/define-goal/scripts/handoff-files.mjs --goal a.md" } },
    { tool_name: "Edit", tool_input: { file_path: path.join(dir, "app.js") } },
    { tool_name: "Write", tool_input: { file_path: path.join(dir, "new.js") } },
    { tool_name: "MultiEdit", tool_input: { file_path: path.join(dir, "app.js") } },
    { tool_name: "NotebookEdit", tool_input: { notebook_path: path.join(dir, "a.ipynb") } },
  ];
  for (const c of calls) assert.equal(pre(dir, c.tool_input, c.tool_name ? { tool_name: c.tool_name } : {}), null, JSON.stringify(c));
  add(dir);
  for (const c of calls) {
    const out = pre(dir, c.tool_input, c.tool_name ? { tool_name: c.tool_name } : {});
    assert.ok(blocked(out), JSON.stringify(c));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /先跑 console\.mjs review sheet、停下等使用者審核/);
  }
});

test("攔截點比對子命令：event start --phase approve 不擋；console.mjs review 開頭一律放行", () => {
  const { dir } = repo();
  add(dir);
  assert.equal(pre(dir, { command: 'node "$FLOW" event start --phase approve' }), null);
  assert.equal(pre(dir, { command: 'echo approve; node "$FLOW" paths' }), null);
  assert.equal(pre(dir, { command: `node "${CONSOLE}" review sheet` }), null);
  assert.ok(blocked(pre(dir, { command: "node /a/flow.mjs approve" })));
});

test("已通過實作前審核的標記：審完寫入後四個攔截點放行；dev-flow reopen 清掉標記又擋", () => {
  const { dir } = repo();
  add(dir);
  assert.equal(cli(dir, "pass", "--n", "1").status, 0);
  const wt = review.worktreeOf(dir);
  const { finishRound } = awaitImport;
  const r = finishRound(wt);
  assert.equal(r.ok, true);
  assert.ok(review.stateOf(wt).approved);
  assert.equal(pre(dir, { command: 'node "$FLOW" approve --auto' }), null);
  assert.equal(pre(dir, { file_path: path.join(dir, "app.js") }, { tool_name: "Edit" }), null);
  add(dir);
  assert.equal(pre(dir, { command: 'node "$FLOW" approve --auto' }), null, "實作階段的代回不擋");
  gate.postToolUse({ tool_name: "Bash", tool_input: { command: 'node "$FLOW" reopen --why "改需求"' }, cwd: dir, session_id: "child-1" });
  assert.equal(review.stateOf(wt).approved, null);
  assert.ok(blocked(pre(dir, { command: 'node "$FLOW" approve --auto' })));
});

test("後端 spec 改回 draft 時清掉已審標記", () => {
  const { dir } = repo();
  add(dir);
  const wt = review.worktreeOf(dir);
  awaitImport.finishRound(wt, { passAll: true });
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "spec.md"), "---\nstatus: draft\n---\n");
  gate.postToolUse({ tool_name: "Edit", tool_input: { file_path: path.join(dir, "docs", "spec.md") }, cwd: dir, session_id: "c" });
  assert.equal(review.stateOf(wt).approved, null);
});

test("第四個攔截點放行 worktree 外的檔、.goals/、規劃產物與自動交棒說明檔", () => {
  const { dir } = repo();
  add(dir);
  for (const f of [path.join(tmp, "elsewhere.md"), path.join(dir, ".goals", "x.md"), path.join(dir, "docs", "dev-flow", "b", "plan.md"), path.join(tmp, "handoff", "notes", "s.md"), path.join(dir, "spec.md")]) {
    assert.equal(pre(dir, { file_path: f }, { tool_name: "Write" }), null, f);
  }
});

test("第四個攔截點對 Bash 不比對寫法、不注入提醒：寫檔指令在 PreToolUse 一律放行", () => {
  const { dir } = repo();
  add(dir);
  for (const command of ["sed -i '' s/a/b/ app.js", "echo x > app.js", "git apply p.diff"]) assert.equal(pre(dir, { command }), null);
});

function runBash(dir, command, session = "child-1") {
  const id = `b${++n}`;
  const input = { tool_name: "Bash", tool_input: { command }, cwd: dir, session_id: session, tool_use_id: id };
  const p = gate.preToolUse(input, { consoleCheck: () => false });
  if (blocked(p)) return { pre: p };
  spawnSync("sh", ["-c", command], { cwd: dir });
  return { pre: p, post: gate.postToolUse(input) };
}

for (const [name, command] of [
  ["sed -i", "sed -i.bak 's/a/b/' app.js && rm app.js.bak"],
  ["> 重新導向", "echo changed > app.js"],
  ["git apply", "printf 'diff --git a/app.js b/app.js\\n--- a/app.js\\n+++ b/app.js\\n@@ -1 +1 @@\\n-a\\n+z\\n' > /tmp/wtc-review-$$.diff && git apply /tmp/wtc-review-$$.diff"],
]) {
  test(`Bash 用 ${name} 改 worktree 內的檔被鎖住：之後改檔與 Bash 都擋，只放行 console.mjs review；檔案不還原`, () => {
    const { dir } = repo();
    add(dir);
    const r = runBash(dir, command);
    assert.equal(r.post?.decision, "block", JSON.stringify(r));
    assert.match(r.post.reason, /已鎖住.*app\.js/);
    assert.notEqual(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "a\n", "檔案沒被還原");
    assert.ok(blocked(pre(dir, { command: "ls" })));
    assert.ok(blocked(pre(dir, { file_path: path.join(dir, ".goals", "x.md") }, { tool_name: "Write" })));
    assert.equal(pre(dir, { command: `node ${CONSOLE} review sheet` }), null);
    assert.equal(pre(dir, { command: "ls" }, { session_id: "other" }), null, "只鎖改檔的那個 session");
    const sheet = cli(dir, "sheet").stdout.split("\n");
    assert.equal(sheet[3], "先看：沒有前例");
    const at = sheet.findIndex((l) => /^\d+\. 規劃階段改了這些檔$/.test(l));
    assert.ok(at > 3, "在先看那區");
    assert.match(sheet.slice(at + 1, at + 4).join("\n"), /影響範圍　app\.js/);
    const nums = sheet.filter((l) => /^\d+\. /.test(l)).map((l) => Number(l.split(".")[0]));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), "編號由上往下遞增，和 review edit --n 用的一致");
  });
}

test("寫規劃產物（.goals/、spec.md、plan.md）的 Bash 不被鎖住", () => {
  const { dir } = repo();
  add(dir);
  const r = runBash(dir, "mkdir -p .goals && echo x > .goals/g.md && echo s > spec.md && echo p > plan.md");
  assert.equal(r.post, null);
  assert.equal(pre(dir, { command: "ls" }), null);
});

test("approve、confirm-spec、handoff-files.mjs 另外檢查 worktree：規劃產物以外有改動就擋下（沒有待審代回也擋）", () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, "app.js"), "changed\n");
  fs.mkdirSync(path.join(dir, ".goals"));
  fs.writeFileSync(path.join(dir, ".goals", "g.md"), "x");
  for (const command of ['node "$FLOW" approve --auto', 'python3 "$FLOW" confirm-spec', "node handoff-files.mjs"]) {
    const out = pre(dir, { command });
    assert.ok(blocked(out), command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /規劃產物以外有改動：app\.js/);
  }
  const clean = repo();
  fs.writeFileSync(path.join(clean.dir, "spec.md"), "s");
  assert.equal(pre(clean.dir, { command: 'python3 "$FLOW" confirm-spec' }), null);
});

test("讀不到審核紀錄或出錯時回 deny 並寫原因，不放行", () => {
  const { dir } = repo();
  add(dir);
  fs.appendFileSync(review.reviewFile(path.basename(dir), "feat/demo-card"), "{壞掉的一行\n");
  const out = pre(dir, { command: 'node "$FLOW" approve' });
  assert.ok(blocked(out));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /讀不到審核紀錄或檢查出錯.*讀不懂/);
  const cmd = spawnSync(process.execPath, [HOOK, "pre-tool-use"], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(dir, "app.js") }, cwd: dir, session_id: "x" }), encoding: "utf8", env: env() });
  assert.equal(JSON.parse(cmd.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("審核通過只能由中控台與焦點面板寫：子 session 跑改狀態的指令或直接寫 reviews/ 被擋，review add 放行", () => {
  const { dir } = repo();
  for (const command of [`node ${CONSOLE} review pass --n 1`, `node ${CONSOLE} review done`, `node ${CONSOLE} review edit --n 1 --to x`, "echo '{}' >> ~/.worktree-console/reviews/r/b/review.jsonl"]) {
    const out = pre(dir, { command });
    assert.ok(blocked(out), command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /只能由中控台與焦點面板寫/);
  }
  assert.ok(blocked(pre(dir, { file_path: path.join(tmp, "log", "reviews", "r", "review.jsonl") }, { tool_name: "Write" })));
  assert.equal(pre(dir, { command: `node ${CONSOLE} review add --question q` }), null);
  const consoleRun = gate.preToolUse({ tool_name: "Bash", tool_input: { command: `node ${CONSOLE} review pass --n 1` }, cwd: dir, session_id: "console" }, { consoleCheck: () => true });
  assert.equal(consoleRun, null);
});

test("SessionStart 對每個子 session 加進四條規則：10 類緊急名單、用 review add 記下推測的決定、停點五條件都成立就直接做（不等開工／OK／繼續，送出並合併仍等使用者）、最後一行寫等你或已完成", () => {
  const { dir } = repo();
  const r = spawnSync(process.execPath, [HOOK, "session-start"], { input: JSON.stringify({ cwd: dir, session_id: "s" }), encoding: "utf8", env: env() });
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  for (const k of ["等待授權", "session 異常", "push、合併、刪資料或 branch、寫 Linear／Slack、改遠端設定", "方向、範圍、資料寫入、權限", "需使用者本人判定的驗收與原型確認", "加進〈不做〉或拿掉先前決定", "要用秘密值", "要連 SSH 或 RDS", "連續 3 個假設失敗", "判斷不出是否緊急"]) assert.ok(ctx.includes(k), k);
  assert.match(ctx, /review add --question/);
  assert.match(ctx, /--before <改前截圖> --after <改後截圖>（本機 dev server 截的），截不到時加 --prototype/);
  assert.match(ctx, /整則都等使用者回/);
  assert.match(ctx, /3\. CLAUDE\.md〈停點〉的五個條件都成立，就直接做，不在結尾停下等「開工」「OK」「繼續」/);
  assert.match(ctx, /碰到第 1 條的任一類照舊先停；「送出並合併」一定等使用者本人說/);
  assert.ok(ctx.indexOf("1. 緊急名單") < ctx.indexOf("3. CLAUDE.md"), "緊急名單排在前面");
  assert.match(ctx, /4\. 每次停下，回覆最後一行固定寫「等你：<要使用者做什麼>」或「已完成」/);
  const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8")).hooks;
  assert.ok(hooks.SessionStart.some((g) => g.hooks.some((h) => h.command.includes("review-gate.mjs\" session-start"))));
  assert.ok(hooks.PreToolUse.some((g) => g.matcher === "Bash|Edit|Write|MultiEdit|NotebookEdit" && g.hooks.some((h) => h.command.includes("review-gate.mjs"))));
  const outside = spawnSync(process.execPath, [HOOK, "session-start"], { input: JSON.stringify({ cwd: tmp }), encoding: "utf8", env: env() });
  assert.equal(outside.stdout, "", "不在 git 裡不加");
});

const awaitImport = await import("../skills/worktree-console/scripts/review-cli.mjs");

test("範例：前端畫面附改前改後截圖（截不到時附原型截圖並標「這是原型」）；複雜邏輯附 mermaid 流程圖；簡單行為寫一個「如果…，會…」情境", () => {
  const { dir } = repo();
  const wt = review.worktreeOf(dir);
  const { makeExample } = awaitImport;
  assert.equal(add(dir, ["--before", "/shots/before.png", "--after", "/shots/after.png"]).status, 0);
  assert.equal(add(dir, ["--prototype", "/shots/proto.png"]).status, 0);
  add(dir);
  add(dir);
  const items = review.stateOf(wt).open;
  const shot = makeExample(wt, items[0], () => assert.fail("有截圖不叫模型"));
  assert.match(fs.readFileSync(shot.file, "utf8"), /改前[\s\S]*before\.png[\s\S]*改後[\s\S]*after\.png/);
  const proto = makeExample(wt, items[1], () => assert.fail("有截圖不叫模型"));
  assert.match(fs.readFileSync(proto.file, "utf8"), /這是原型[\s\S]*proto\.png/);
  assert.match(proto.answer, /這是原型/);
  const flow = makeExample(wt, items[2], () => JSON.stringify({ kind: "flow", mermaid: "flowchart TD\n  A-->B" }));
  assert.match(fs.readFileSync(flow.file, "utf8"), /```mermaid\nflowchart TD\n {2}A-->B\n```/);
  const scene = makeExample(wt, items[3], () => JSON.stringify({ kind: "scenario", text: "如果欄位只有 46 欄，會先縮短進度條" }));
  assert.equal(scene.answer, "如果欄位只有 46 欄，會先縮短進度條");
  assert.equal(makeExample(wt, items[3], () => JSON.stringify({ kind: "scenario", text: "沒有情境句" })), null, "不是「如果…，會…」不收");
});

test("x 就地問：空白要範例、打字問任意問題，回答另寫一行 ask 插在那件下面；多輪都留著", () => {
  const { dir } = repo();
  add(dir);
  const model = path.join(tmp, "model.sh");
  fs.writeFileSync(model, `#!/bin/sh\ncat > /dev/null\necho '{"kind":"scenario","text":"如果點了卡片，會打開審核單"}'\n`);
  fs.chmodSync(model, 0o755);
  const run = (...a) => spawnSync(process.execPath, [CONSOLE, "review", ...a], { cwd: dir, encoding: "utf8", env: { ...env(), WORKTREE_CONSOLE_REVIEW_MODEL_CMD: model } });
  const ex = run("ask", "--n", "1");
  assert.equal(ex.status, 0, ex.stderr);
  assert.equal(ex.stdout.trim(), "如果點了卡片，會打開審核單");
  assert.equal(run("ask", "--n", "1", "--q", "為什麼不用實線？").status, 0);
  const data = JSON.parse(run("data").stdout);
  assert.deepEqual(data.fresh[0].asks.map((a) => a.q), ["（要範例）", "為什麼不用實線？"]);
  assert.ok(data.fresh[0].example.endsWith(".md"));
});

test("x 問沒有目標檔：改讀 worktree 的規劃文件與子 session 的對話回答，並要求查不到就說查不到；三樣都沒有時不問模型，直接回查不到", () => {
  const projects = fs.mkdtempSync(path.join(tmp, "projects-"));
  const seen = path.join(tmp, `prompt-${n}.txt`);
  const model = path.join(tmp, `model-${n}.sh`);
  fs.writeFileSync(model, `#!/bin/sh\ncat > "${seen}"\necho 規劃文件寫了先做 API。\n`);
  fs.chmodSync(model, 0o755);
  const clean = { ...env(), WORKTREE_CONSOLE_REVIEW_MODEL_CMD: model, CLAUDE_PROJECTS_DIR: projects };
  delete clean.CLAUDE_CODE_SESSION_ID;
  const ask = (dir, q) => spawnSync(process.execPath, [CONSOLE, "review", "ask", "--n", "1", "--q", q], { cwd: dir, encoding: "utf8", env: clean });

  const bare = repo("feat/bare-ask");
  cli(bare.dir, "add", ...good, "--session", "none-such");
  const r0 = ask(bare.dir, "為什麼先做 API？");
  assert.equal(r0.status, 0, r0.stderr);
  assert.match(r0.stdout, /^查不到：這個 worktree 沒有目標檔、規劃文件，也讀不到子 session 的對話/);
  assert.equal(fs.existsSync(seen), false, "沒問模型");

  const planned = repo("feat/planned-ask");
  fs.mkdirSync(path.join(planned.dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(planned.dir, "docs", "plan.md"), "# 計畫\n先做 API，再做畫面。\n");
  fs.mkdirSync(path.join(projects, "-wt"));
  fs.writeFileSync(path.join(projects, "-wt", "s-plan.jsonl"), [
    { type: "user", message: { content: "先做哪個？" } },
    { type: "assistant", message: { content: [{ type: "text", text: "我建議先做 API，畫面等資料格式定了再接。" }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  cli(planned.dir, "add", ...good, "--session", "s-plan");
  const r1 = ask(planned.dir, "為什麼先做 API？");
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stdout.trim(), "規劃文件寫了先做 API。");
  const prompt = fs.readFileSync(seen, "utf8");
  assert.match(prompt, /規劃文件：\n# docs\/plan\.md\n# 計畫\n先做 API，再做畫面。/);
  assert.match(prompt, /子 session 的對話（最後一段）：\n使用者：先做哪個？\n\n子 session：我建議先做 API/);
  assert.match(prompt, /查不到答案時，只回一句「查不到：<缺的是什麼>」，不要推測/);
  assert.doesNotMatch(prompt, /目標檔：/);
});

test("review undo：通過或改過的那件退回待審（另寫一行 undo，不改舊行）；本來就待審的不能退", () => {
  const { dir } = repo("feat/undo-card");
  add(dir);
  add(dir);
  assert.equal(cli(dir, "pass", "--n", "1").status, 0);
  assert.equal(cli(dir, "edit", "--n", "2", "--to", "改成灰色").status, 0);
  const u2 = cli(dir, "undo", "--n", "2");
  assert.equal(u2.status, 0, u2.stderr);
  assert.equal(u2.stdout.trim(), "第 2 件已退回待審");
  assert.equal(cli(dir, "undo", "--n", "1").status, 0);
  const data = JSON.parse(cli(dir, "data").stdout);
  assert.deepEqual(data.fresh.map((x) => [x.n, x.status, x.edit]), [[1, "pending", null], [2, "pending", null]]);
  const again = cli(dir, "undo", "--n", "1");
  assert.equal(again.status, 1);
  assert.match(again.stdout + again.stderr, /第 1 件本來就是待審/);
});
