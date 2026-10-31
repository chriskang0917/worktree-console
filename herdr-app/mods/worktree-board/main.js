// worktree-console's board beside the terminals: one row per session, the ones waiting on you on top.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, appHome, readTextFile, run, theme, watchFolder } from "herdr";
import { boardView, parseState } from "./board.js";

const dirOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

export default class WorktreeBoard extends View {
  init(_props, cx) {
    this.state = null;
    this.file = null;
    cx.spawn(async (cx) => {
      this.file = ((await readTextFile(`${appHome()}/mods/worktree-board/.board-path`)) ?? "").trim() || null;
      await this.load(cx);
      if (!this.file) return;
      for (;;) {
        const changed = await watchFolder(dirOf(this.file)).catch(() => null);
        if (!changed) return;
        if (changed.includes(this.file)) await this.load(cx);
      }
    });
    // Ages and the stale notice move with the clock; the file is read again in case the folder can't be watched.
    cx.timer.every(15000, (cx) => cx.spawn(async (cx) => this.load(cx)));
  }

  async load(cx) {
    if (this.file) this.state = parseState(await readTextFile(this.file).catch(() => null));
    cx.notify();
  }

  open(terminal) {
    const a = agents().find((x) => x.address === terminal);
    if (a) run("tab.select", { id: a.tab });
  }

  render() {
    const t = theme();
    const view = boardView(this.state, Date.now());
    const fg = view.stale ? t.dim : t.foreground;
    return v_flex()
      .id("worktree-board")
      .size_full()
      .bg(t.chrome)
      .p(8)
      .gap(2)
      .text_size(12.5)
      .child(div().px(6).pb(4).text_size(11).text_color(t.dim).child("worktree 看板"))
      .when(!!view.note, (el) => el.child(div().px(6).py(4).mb(2).rounded(6).bg(t.raised).text_size(11.5).text_color(t.muted).child(view.note)))
      .when(view.rows.length === 0 && !view.note, (el) => el.child(div().px(6).text_color(t.dim).child("沒有 session")))
      .child(
        v_flex()
          .id("worktree-board-rows")
          .flex_1()
          .overflow_y_scrollbar()
          .gap(1)
          .children(
            view.rows.map((r) =>
              h_flex()
                .id(`row-${r.terminal ?? r.tag}`)
                .h(26)
                .px(6)
                .gap(8)
                .rounded(6)
                .items_center()
                .when(view.stale, (el) => el.opacity(0.55))
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.open(r.terminal))
                .child(div().w(18).flex_none().child(r.icon))
                .child(div().flex_1().truncate().text_color(fg).child(r.tag))
                .child(div().flex_none().text_color(t.dim).child(r.wait)),
            ),
          ),
      );
  }
}
