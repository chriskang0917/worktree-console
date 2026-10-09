// Ambiguous symbols use one cell; emoji clusters use two.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ONE_CELL = "◇◆●○◌★…↪✓·✢✳✶!?∘◜◝◞◟⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⌖›+~▌";
const WIDE = /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3041-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{16fe0}-\u{16fe4}\u{17000}-\u{18dff}\u{1aff0}-\u{1afff}\u{1b000}-\u{1b2ff}\u{20000}-\u{3fffd}]/u;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}|[\u{1f1e6}-\u{1f1ff}]|\u20e3/u;

export function* graphemes(text) {
  for (const { segment } of segmenter.segment(String(text ?? ""))) yield segment;
}

export function displayWidth(text) {
  let width = 0;
  for (const cluster of graphemes(text)) {
    if (cluster.length === 1 && ONE_CELL.includes(cluster)) { width++; continue; }
    if (EMOJI.test(cluster) || /\p{Emoji}\ufe0f/u.test(cluster)) { width += 2; continue; }
    let cells = 0;
    for (const char of cluster) {
      if (/\p{Mark}/u.test(char) || char === "\u200d") continue;
      cells = Math.max(cells, WIDE.test(char) ? 2 : 1);
    }
    width += cells;
  }
  return width;
}
