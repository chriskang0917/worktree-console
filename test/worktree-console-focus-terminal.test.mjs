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
          assert.match(header, new RegExp(`${index === 3 ? '閒置    ' : '已回覆  '}${prefix}0${index === 2 ? '  取消封存' : ''} +[║│]$`), "首卡標頭右側沒有覆畫的數字");
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
