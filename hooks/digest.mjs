// The four-layer recap scripts/summary.mjs writes, read the same way by the reports, the child tab's band and the console's popovers.
export const LAYER_LABELS = { doing: "在做什麼", stuck: "卡在哪", done: "做了什麼", decide: "要你決定", next: "下一步" };
export const DECIDE_MARK = "▶ ";
export const DIGEST_RULE = "摘要";
const ORDER = ["doing", "stuck", "done", "decide", "next"];
const LAYER_MAX_LINES = 2;
// Recaps written before the labels changed: 前提, 問題, 解法, 建議.
const OLD = { 前提: "doing", 問題: "stuck", 解法: "done" };
const NEW = Object.fromEntries(Object.entries(LAYER_LABELS).map(([k, v]) => [v, k]));
const LINE = /^(在做什麼|卡在哪|做了什麼|要你決定|下一步|前提|問題|解法|建議)\s*[：:]\s*(.*)$/;
const NOTHING = /^(無|沒有|none|n\/a|—|-)?[。.]?$/i;

const clean = (line) => line.replace(/^\s*(?:[-*•]\s+)?(?:\*\*)?(?:▶\s*)?/, "").replace(/\*\*/g, "").trim();

function joinAdvice(line, advice) {
  if (!line) return `建議：${advice}`;
  return /[？?。！!，,：:]$/.test(line) ? `${line}建議：${advice}` : `${line}，建議：${advice}`;
}

// The recap's layers in order, each { key, label, lines } with at most two lines; null when no line carries a label.
export function digestLayers(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const layers = new Map();
  let last = null;
  const add = (key, line) => {
    if (!layers.has(key)) layers.set(key, []);
    if (line) layers.get(key).push(line);
    last = key;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) continue;
    const m = LINE.exec(line);
    if (!m) {
      if (last) layers.get(last).push(line);
      continue;
    }
    const [, label, rest] = m;
    const body = rest.trim();
    if (label === "建議") {
      const decide = /^要你決定\s*[：:]\s*(.*)$/.exec(body);
      if (decide) add("decide", decide[1].trim());
      else {
        const key = layers.has("next") && !layers.has("decide") ? "next" : "decide";
        const lines = layers.get(key) ?? [];
        layers.set(key, lines.length ? [joinAdvice(lines[0], body), ...lines.slice(1)] : [joinAdvice("", body)]);
        last = key;
      }
      continue;
    }
    const key = NEW[label] ?? OLD[label];
    if (key === "stuck" && NOTHING.test(body)) {
      last = null;
      continue;
    }
    add(key, body);
  }
  const out = ORDER.filter((k) => layers.get(k)?.length).map((key) => ({ key, label: LAYER_LABELS[key], lines: layers.get(key).slice(0, LAYER_MAX_LINES) }));
  return out.length ? out : null;
}

// U+3000 is two columns and Markdown keeps it, so the labels line up as a column in /focus-show.
const WIDE_SPACE = "　";
const LABEL_COLS = 12;
const cols = (s) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　]/.test(c) ? 2 : 1), 0);
const pad = (label) => WIDE_SPACE.repeat(Math.max(1, Math.round((LABEL_COLS - cols(label)) / 2)));

// The recap as Markdown under a report: a 摘要 rule, one bold label per layer, a blank line before ▶ 要你決定.
export function digestMarkdown(layers) {
  if (!layers?.length) return [];
  const out = ["", `── ${DIGEST_RULE} ──`, ""];
  for (const layer of layers) {
    const label = layer.key === "decide" ? `${DECIDE_MARK}${layer.label}` : layer.label;
    if (layer.key === "decide" && out.at(-1) !== "") out.push("");
    layer.lines.forEach((line, i) => {
      const head = i === 0 ? `**${label}**${pad(label)}` : WIDE_SPACE.repeat(LABEL_COLS / 2);
      out.push(`${head}${line}`);
    });
  }
  return out.map((l, i, all) => (l && all[i + 1] ? `${l}  ` : l));
}
