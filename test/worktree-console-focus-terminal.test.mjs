import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { terminalFixture } from "./fixtures/worktree-console/focus-terminal.mjs";

const tabs = [["q", "待回覆"], ["w", "全部"], ["e", "封存"], ["r", "閒置"]];

// Read the real terminal's cells, not the mount kit's unpainted element tree.
function panel(frame) {
  const lines = frame.split("\n");
  const tabIndex = lines.findIndex(line => line.includes("q:"));
  assert.ok(tabIndex >= 0, frame);
  // Crop after the dock divider; never simulate wrapping or clipping.
  return lines.slice(0, 43).map(line => {
    const divider = line.indexOf("│", 40);
    return divider < 0 ? "" : line.slice(divider + 1).trimEnd();
  });
}

for (const [cols, counts] of [[39, [6, 12, 0, 0]], [39, [12, 24, 10, 11]], [46, [6, 12, 0, 0]], [46, [12, 24, 1, 1]]]) {
  test(`真實終端：${cols} 欄、${counts.join("／")}，四個所選分頁完整且不覆畫標頭`, { timeout: 30_000 }, async () => {
    const evidence = process.env.WTC_FIX8_EVIDENCE && cols === 39 && counts[0] === 6;
    const terminal = await terminalFixture({ counts, columns: cols + 71, socket: evidence ? "wtcfix8" : undefined });
    try {
      await terminal.open();
      for (const [index, [key, label]] of tabs.entries()) {
        const expectedContent = frame => {
          const content = panel(frame).join("\n");
          if (!counts[index]) return content.includes("目前沒有符合條件的 session");
          return content.includes(`${["reply", "reply", "archive", "idle"][index]}0`)
            && (index !== 1 || content.includes("── fixture"));
        };
        const frame = await terminal.press(key, expectedContent);
        const lines = panel(frame);
        const row = lines.findIndex(line => line.startsWith("q:"));
        assert.ok(lines[row].includes(`${key}: ${label} ${counts[index]}`), lines.join("\n"));
        for (const [hotkey] of tabs) assert.ok(lines[row].includes(`${hotkey}:`), lines[row]);
        assert.match(lines[row + 1], /^[─━]+$/, "分頁只有一行，下一行必須是底線");
        assert.equal([...lines[row + 1]].length, cols, "確認面板的實際欄寬");
        const segmentStart = lines[row].indexOf(`${key}:`);
        const segment = lines[row].slice(segmentStart).split(/  (?=[qwer]:)/)[0];
        const cellWidth = text => [...text].reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 2 : 1), 0);
        const start = cellWidth(lines[row].slice(0, segmentStart));
        const end = start + cellWidth(segment);
        assert.equal(lines[row + 1], `${"─".repeat(start)}${"━".repeat(end - start)}${"─".repeat(cols - end)}`, `${key} 的粗底線必須只在所選分頁下方`);
        assert.ok(expectedContent(frame), "所選分頁內容必須完成繪製");
        if (cols === 46) {
          assert.equal(lines[row], `q: 待回覆 ${counts[0]}  w: 全部 ${counts[1]}  e: 封存 ${counts[2]}  r: 閒置 ${counts[3]}`);
        }
        if (counts[index]) {
          const prefix = ["reply", "reply", "archive", "idle"][index];
          const header = lines.find(line => line.includes(`${prefix}0`) && /[║│]/.test(line));
          assert.ok(header, lines.join("\n"));
          assert.match(header, new RegExp(`${index === 3 ? '閒置    ' : '已回覆  '}${prefix}0${index === 2 ? '  取消封存' : ''}(?: +(?:規劃中|實作中|已推送))? +[║│]$`), "首卡標頭右側沒有覆畫的數字");
        } else {
          assert.ok(lines.some(line => line.includes("目前沒有符合條件的 session")), lines.join("\n"));
        }
        if (evidence) fs.writeFileSync(path.join(process.env.WTC_FIX8_EVIDENCE, `fix8-w39-${key}.txt`), `${lines.join("\n")}\n`);
      }
    } finally {
      await terminal.close();
    }
  });
}

// Foreground in effect for each printed character of one captured line ("default" when reset).
function foregrounds(line) {
  const out = [];
  let fg = "default";
  for (let i = 0; i < line.length;) {
    const m = /^\x1b\[([0-9;:]*)m/.exec(line.slice(i));
    if (m) {
      const p = m[1].split(/[;:]/);
      for (let j = 0; j < p.length; j++) {
        const n = Number(p[j] || 0);
        if (n === 0 || n === 39) fg = "default";
        else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) fg = String(n);
        else if (n === 38) { fg = p[j + 1] === "5" ? `5;${p[j + 2]}` : `2;${p.slice(j + 2, j + 5).join(";")}`; j += p[j + 1] === "5" ? 2 : 4; }
        else if (n === 48) j += p[j + 1] === "5" ? 2 : 4;
      }
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i));
    out.push({ ch, fg });
    i += ch.length;
  }
  return out;
}
const fgOf = (line, text) => {
  const cells = foregrounds(line);
  const at = cells.map(c => c.ch).join("").indexOf(text);
  return at < 0 ? undefined : cells.slice(at, at + [...text].length).map(c => c.fg);
};

test("真實終端：neutral 摘要開頭的數字用預設前景色、其餘灰色；字中數字不拆", { timeout: 30_000 }, async () => {
  const terminal = await terminalFixture({ counts: [2, 2, 0, 0], summaries: ["1 未核對", "面板 v2 改版"], columns: 151 });
  try {
    await terminal.open();
    const frame = await terminal.waitFor(f => f.includes("未核對") && f.includes("面板 v2 改版"), "等待摘要");
    assert.ok(frame);
    const lines = terminal.tmux("capture-pane", "-p", "-e", "-t", "fixture:0.0").split("\n");
    const counted = lines.find(line => line.includes("未核對"));
    const [lead] = fgOf(counted, "1 未核對") ?? [];
    const rest = fgOf(counted, "未核對");
    assert.equal(lead, "default", `開頭數字應是預設前景色：${JSON.stringify(counted)}`);
    assert.ok(rest.every(fg => fg !== "default"), "標籤應是灰色");
    const word = lines.find(line => line.includes("面板 v2 改版"));
    assert.equal(new Set(fgOf(word, "面板 v2 改版")).size, 1, "字中數字維持同色");
  } finally {
    await terminal.close();
  }
});

test("真實終端：切分頁、重按同一分頁與上下移動後，選中卡逐步正確，焦點反白只在選中的卡名上", { timeout: 90_000 }, async () => {
  const terminal = await terminalFixture({ counts: [4, 6, 0, 0], columns: 151 });
  const width = text => [...text].reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 2 : 1), 0);
  const plain = text => text.replace(/\x1b\[[0-9;]*m/g, "");
  // The shown tab (the label over the ━ underline), the framed card's name and every inverse run in the panel.
  const read = () => {
    // The panel's part of each row: after its dock divider; the prompt's own cursor block sits left of it.
    const parts = terminal.tmux("capture-pane", "-p", "-e", "-t", "fixture:0.0").split("\n").map(line => line.indexOf("│", 40) < 0 ? "" : line.slice(line.indexOf("│", 40) + 1));
    const text = parts.map(plain);
    const row = text.findIndex(line => line.startsWith("q:"));
    const under = text[row + 1] ?? "";
    // The underline row is only ─ and ━, one column each.
    const mark = under.indexOf("━");
    let start = 0;
    const tab = (text[row] ?? "").trimEnd().split(/  (?=[qwer]:)/).find(segment => {
      const hit = mark >= start && mark < start + width(segment);
      start += width(segment) + 2;
      return hit;
    })?.replace(/^[qwer]: (\S+).*$/, "$1");
    const selected = text.find(line => line.startsWith("║") && /\b(reply|work)\d\b/.test(line))?.match(/\b(reply|work)\d\b/)[0];
    const inverse = parts.flatMap((part, i) => [...part.matchAll(/\x1b\[7m(.*?)\x1b\[(?:0|27)m/g)].map(m => ({ framed: text[i].startsWith("║"), label: plain(m[1]).trim() }))).filter(run => run.label);
    return { tab, selected, inverse };
  };
  const settled = (state, tab, card) => state.tab === tab && state.selected === card && state.inverse.length > 0 && state.inverse.every(run => run.framed && run.label === card);
  try {
    await terminal.open();
    const steps = [
      ["w", "全部", "reply0"], ["Down", "全部", "reply1"],
      ["q", "待回覆", "reply0"], ["Down", "待回覆", "reply1"],
      ["w", "全部", "reply0"], ["Down", "全部", "reply1"],
      // Pressing the shown tab's key again puts the selection back on its first card; the next ↓ still moves one card.
      ["w", "全部", "reply0"], ["Down", "全部", "reply1"], ["Down", "全部", "reply2"],
      // `0` reopens the panel on 待回覆 with the band's question selected, wherever the ring was before.
      ["0", "待回覆", "reply0"], ["Down", "待回覆", "reply1"],
      ["q", "待回覆", "reply0"], ["Down", "待回覆", "reply1"],
    ];
    for (const [i, [key, tab, card]] of steps.entries()) {
      terminal.tmux("send-keys", "-t", "fixture:0.0", key);
      const deadline = Date.now() + 5_000;
      let state = read();
      while (Date.now() < deadline && !settled(state, tab, card)) {
        await new Promise(resolve => setTimeout(resolve, 100));
        state = read();
      }
      assert.ok(settled(state, tab, card), `第 ${i + 1} 步 ${key} 後應在「${tab}」選中 ${card}，焦點反白在它的名字上：${JSON.stringify(state)}`);
      // Re-read once the delayed re-focus has had its frames: the ring must not drift off the selected card.
      await new Promise(resolve => setTimeout(resolve, 600));
      state = read();
      assert.ok(settled(state, tab, card), `第 ${i + 1} 步 ${key} 之後焦點漂移：${JSON.stringify(state)}`);
    }
  } finally {
    await terminal.close();
  }
});

// A task as the task-list CLI stores it, timed against now so the panel's relative times read the same in every run.
function todoTask(now) {
  const ago = minutes => new Date(now - minutes * 60_000).toISOString();
  const group = (id, title, status, order) => ({ id, kind: "group", title, status, order });
  const leaf = (id, parentId, title, status, order, extra = {}) => ({ id, ...(parentId ? { parentId } : {}), kind: "leaf", title, status, order, ...extra });
  return {
    schemaVersion: 2, title: "面板改版",
    items: [
      group("g1", "面板待辦分頁", "doing", 0),
      leaf("c1", "g1", "確認 hotkey", "waiting", 0),
      leaf("c2", "g1", "畫摘要列", "doing", 1, { blockedBy: ["c4"] }),
      leaf("c3", "g1", "寫測試", "done", 2),
      group("g2", "資料讀取與錯誤處理", "doing", 1),
      leaf("c4", "g2", "讀檔", "blocked", 0),
      leaf("c5", "g2", "解析", "queued", 1),
      leaf("c6", "g2", "錯誤提示", "queued", 2),
      leaf("c7", "g2", "輪詢", "review", 3),
      leaf("c8", "g2", "快取", "queued", 4),
      leaf("r1", null, "整理 README", "queued", 2),
      group("g3", "store 交易", "done", 3),
      leaf("c10", "g3", "commit 流程", "done", 0),
    ],
    reports: [{ id: "rep1", itemId: "c3", ack: false }, { id: "rep2", itemId: "c10", ack: true }],
    events: [
      { revision: 0, occurredAt: ago(120), command: "建立任務" },
      { revision: 1, occurredAt: ago(90), command: "item move", result: { id: "c5" } },
      { revision: 2, occurredAt: ago(3), command: "report submit", result: { id: "rep1", status: "review" } },
      { revision: 3, occurredAt: ago(2), command: "report accept", result: { id: "rep2" } },
    ],
  };
}

const cells = text => [...text].reduce((n, c) => n + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);

// 39 is the narrowest docked pane (the dock starts at 110 terminal columns); 36 is covered by the mount kit test.
for (const cols of [80, 46, 39]) {
  test(`真實終端：${cols} 欄的待辦分頁每列一行不換行，t 排最後並有底線，頁尾是 qwert`, { timeout: 30_000 }, async () => {
    // The dock takes a share of the terminal, not a fixed 71 columns, once the terminal is wide.
    const terminal = await terminalFixture({ counts: [2, 3, 0, 0], columns: { 80: 180, 46: 117, 39: 110 }[cols], task: todoTask(Date.now()) });
    try {
      await terminal.open();
      const frame = await terminal.press("t", frame => panel(frame).some(line => line.startsWith("時間線")));
      const lines = panel(frame);
      const row = lines.findIndex(line => line.startsWith("q:"));
      assert.match(lines[row], cols < 80 ? /^q: 2  w: 3  e: 0  r: 0  t: 待辦 3$/ : /  r: 閒置 0  t: 待辦 3$/);
      assert.equal([...lines[row + 1]].length, cols, "確認面板的實際欄寬");
      const body = lines.slice(row + 2);
      assert.deepEqual(body.filter(line => cells(line) > cols), [], "每列都在欄寬內");
      assert.ok(body.map(line => line.trim()).includes(cols <= 45 ? "qwert 切分頁 · Enter 展開／收合" : "qwert 切分頁 · ↑↓ 選項目 · Enter 展開／收合"), body.join("\n"));
      const summary = { 80: "◆ 1 待回答 · ! 1 受阻 · ◇ 1 待驗收 · ▶ 1 進行 · ○ 4 待辦 · ★ 1 未核對", 46: "◆ 1 · ! 1 · ◇ 1 · ▶ 1 · ○ 4 · ★ 1", 39: "◆ 1 · ! 1 · ◇ 1 · ▶ 1 · ○ 4 · ★ 1" }[cols];
      assert.equal(body[0], summary);
      assert.ok(body.includes("│  ╰─ 還有 2 項"), body.join("\n"));
      if (cols < 46) {
        assert.ok(body.includes("│    完成 1/3 項 · 3 分鐘前"), body.join("\n"));
        // Above 36 columns the dependency stays on the child's row, cut to what is left of it.
        assert.ok(body.includes("│  ├─ ▶ 畫摘要列  前置 資料讀取與錯誤…"), body.join("\n"));
      } else {
        const groups = body.filter(line => /^[├╰┝┕][─━] .* 完成 \d/.test(line));
        assert.equal(groups.length, 2, body.join("\n"));
        assert.equal(new Set(groups.map(line => cells(line))).size, 1, "完成數與時間在同一欄對齊");
        assert.ok(body.includes("│  ├─ ▶ 畫摘要列  前置 資料讀取與錯誤處理/讀檔"), body.join("\n"));
      }
      if (process.env.WTC_TODO_EVIDENCE) fs.writeFileSync(path.join(process.env.WTC_TODO_EVIDENCE, `todo-tab-w${cols}.txt`), `${lines.join("\n")}\n`);
    } finally {
      await terminal.close();
    }
  });
}

// Walks key presses and task rewrites, checking after each step the shown tab, the selected item and that the
// terminal's only focus inverse sits on it, then again 600 ms later so a late re-focus cannot drift off it.
// A step is [key or task rewrite, tab, item]: on card tabs the item is the framed card; on 待辦 it is text of the one
// row drawn in the accent colour (the selection mark), and the inverse is on its label (the arrow is not part of it).
async function walk(terminal, steps) {
  const plain = text => text.replace(/\x1b\[[0-9;]*m/g, "");
  const read = () => {
    const raw = terminal.tmux("capture-pane", "-p", "-e", "-t", "fixture:0.0").split("\n");
    const parts = raw.map(line => line.indexOf("│", 40) < 0 ? "" : line.slice(line.indexOf("│", 40) + 1));
    const text = parts.map(plain);
    const row = text.findIndex(line => line.startsWith("q:"));
    const mark = (text[row + 1] ?? "").indexOf("━");
    let start = 0;
    const tab = (text[row] ?? "").trimEnd().split(/  (?=[qwert]:)/).find(segment => {
      const hit = mark >= start && mark < start + cells(segment);
      start += cells(segment) + 2;
      return hit;
    })?.replace(/^[qwert]: (\S+).*$/, "$1");
    const framed = text.find(line => line.startsWith("║") && /\b(reply|work)\d\b/.test(line))?.match(/\b(reply|work)\d\b/)[0];
    const inverse = parts.flatMap((part, i) => [...part.matchAll(/\x1b\[7m(.*?)\x1b\[(?:0|27)m/g)].map(m => ({ framed: text[i].startsWith("║"), label: plain(m[1]).trim() }))).filter(run => run.label);
    // Rows below the tab underline with any cell in the accent colour, read off the underline's ━.
    const panelCells = line => {
      const drawn = foregrounds(line);
      const divider = drawn.findIndex((cell, k) => k >= 40 && cell.ch === "│");
      return divider < 0 ? [] : drawn.slice(divider + 1);
    };
    const accent = row < 0 ? undefined : panelCells(raw[row + 1] ?? "").find(cell => cell.ch === "━")?.fg;
    const marked = raw.flatMap((line, i) => {
      if (!accent || i <= row + 1) return [];
      const drawn = panelCells(line);
      return drawn.some(cell => cell.fg === accent) ? [drawn.map(cell => cell.ch).join("").trimEnd()] : [];
    });
    return { tab, framed, inverse, marked };
  };
  const settled = (state, tab, item) => state.tab === tab && state.inverse.length > 0
    && (tab === "待辦"
      ? state.inverse.length === 1 && state.inverse[0].label === item.replace(/ [▸▾]$/, "") && state.marked.length === 1 && state.marked[0].includes(item)
      : state.framed === item && state.inverse.every(run => run.framed && run.label === item));
  for (const [i, [action, tab, item]] of steps.entries()) {
    if (typeof action === "string") terminal.tmux("send-keys", "-t", "fixture:0.0", action);
    else await action();
    // A rewrite shows only at the next poll, up to 5 s away.
    const deadline = Date.now() + (typeof action === "string" ? 5_000 : 9_000);
    let state = read();
    while (Date.now() < deadline && !settled(state, tab, item)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      state = read();
    }
    const name = typeof action === "string" ? action : "等輪詢";
    assert.ok(settled(state, tab, item), `第 ${i + 1} 步 ${name} 後應在「${tab}」選中 ${item}，焦點反白只在它上面：${JSON.stringify(state)}`);
    await new Promise(resolve => setTimeout(resolve, 600));
    state = read();
    assert.ok(settled(state, tab, item), `第 ${i + 1} 步 ${name} 之後焦點漂移：${JSON.stringify(state)}`);
  }
}

test("真實終端：切到待辦再切回卡片分頁，選取與焦點反白都跟著選中的項目，↓ 不被吞掉", { timeout: 90_000 }, async () => {
  const terminal = await terminalFixture({ counts: [4, 6, 0, 0], columns: 151, task: todoTask(Date.now()) });
  try {
    await terminal.open();
    await walk(terminal, [
      ["w", "全部", "reply0"], ["Down", "全部", "reply1"],
      ["t", "待辦", "面板待辦分頁"], ["Down", "待辦", "資料讀取與錯誤處理"],
      ["w", "全部", "reply0"], ["Down", "全部", "reply1"],
      // Pressing 待辦's key again goes back to its first row; ↓ still moves one row.
      ["t", "待辦", "面板待辦分頁"], ["t", "待辦", "面板待辦分頁"], ["Down", "待辦", "資料讀取與錯誤處理"],
      ["q", "待回覆", "reply0"], ["Down", "待回覆", "reply1"],
    ]);
  } finally {
    await terminal.close();
  }
});

// The same task with some items changed, as later polls read it.
const taskWith = (task, change) => ({ ...task, items: task.items.flatMap(change) });
const finish = ids => item => [ids.includes(item.id) || ids.includes(item.parentId) ? { ...item, status: "done" } : item];

test("真實終端：待辦的「還有 N 項」按下後消失，選取退到它的大項，焦點反白跟著，下一個 ↓ 正確", { timeout: 90_000 }, async () => {
  const terminal = await terminalFixture({ counts: [2, 3, 0, 0], columns: 151, task: todoTask(Date.now()) });
  try {
    await terminal.open();
    await walk(terminal, [
      ["t", "待辦", "面板待辦分頁"], ["Down", "待辦", "資料讀取與錯誤處理"], ["Down", "待辦", "還有 2 項"],
      ["Enter", "待辦", "資料讀取與錯誤處理"], ["Down", "待辦", "已完成 2 項 ▸"],
    ]);
  } finally {
    await terminal.close();
  }
});

test("真實終端：輪詢讀到選中的大項完成，已完成收合或展開時選取都落到「已完成」，之後自己選完成的大項不會被拉走", { timeout: 120_000 }, async () => {
  const task = todoTask(Date.now());
  const terminal = await terminalFixture({ counts: [2, 3, 0, 0], columns: 151, task });
  const g2done = taskWith(task, finish(["g2"]));
  try {
    await terminal.open();
    await walk(terminal, [
      ["t", "待辦", "面板待辦分頁"], ["Down", "待辦", "資料讀取與錯誤處理"],
      [() => terminal.writeTask(g2done), "待辦", "已完成 7 項 ▸"], ["Down", "待辦", "時間線 · 4 ▾"],
      // With 已完成 open the finished group keeps its row (now in the fold), and the selection still moves to 已完成.
      ["Up", "待辦", "已完成 7 項 ▸"], ["Enter", "待辦", "已完成 7 項 ▾"], ["Up", "待辦", "面板待辦分頁"],
      [() => terminal.writeTask(taskWith(g2done, finish(["g1"]))), "待辦", "已完成 9 項 ▾"],
      ["Down", "待辦", "面板待辦分頁"],
      // A done group the user picks stays picked across the next poll.
      [() => new Promise(resolve => setTimeout(resolve, 6_000)), "待辦", "面板待辦分頁"],
    ]);
  } finally {
    await terminal.close();
  }
});

test("真實終端：輪詢讀到選中的大項被移除，選取退到上一列，焦點反白跟著，下一個 ↓ 正確", { timeout: 90_000 }, async () => {
  const task = todoTask(Date.now());
  const terminal = await terminalFixture({ counts: [2, 3, 0, 0], columns: 151, task });
  try {
    await terminal.open();
    await walk(terminal, [
      ["t", "待辦", "面板待辦分頁"], ["Down", "待辦", "資料讀取與錯誤處理"],
      [() => terminal.writeTask(taskWith(task, item => (item.id === "g2" || item.parentId === "g2" ? [] : [item]))), "待辦", "面板待辦分頁"],
      ["Down", "待辦", "已完成 2 項 ▸"],
    ]);
  } finally {
    await terminal.close();
  }
});

test("真實終端：輪詢在選中項目上方加入或移除可選列，焦點反白仍在選中的項目，下一個 ↓ 正確", { timeout: 90_000 }, async () => {
  const task = todoTask(Date.now());
  const terminal = await terminalFixture({ counts: [2, 3, 0, 0], columns: 151, task });
  const added = { ...task, items: [{ id: "g0", kind: "group", title: "新的大項", status: "queued", order: -1 }, { id: "c0", parentId: "g0", kind: "leaf", title: "新的小項", status: "queued", order: 0 }, ...task.items] };
  try {
    await terminal.open();
    await walk(terminal, [
      ["t", "待辦", "面板待辦分頁"], ["Down", "待辦", "資料讀取與錯誤處理"],
      [() => terminal.writeTask(added), "待辦", "資料讀取與錯誤處理"], ["Down", "待辦", "還有 2 項"],
      [() => terminal.writeTask(task), "待辦", "還有 2 項"], ["Down", "待辦", "已完成 2 項 ▸"],
    ]);
  } finally {
    await terminal.close();
  }
});
