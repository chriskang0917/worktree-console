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
