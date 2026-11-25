// Non-sidebar additions: tab actions, Changes panel integration and custom
// toast rendering. Sidebar behavior lives in the herdr-over9k fork.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, layout, props, run, setShared, settings, shared, theme, window } from "herdr";


function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}


const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

function renderToast(p, t, view) {
  const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
  const command = login ? `hc machine login ${login[1]}` : null;
  return h_flex()
    .id("toast")
    .size_full()
    .px(18)
    .gap(12)
    .items_center()
    .bg(t.popover)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => {
      if (p.action?.name) run(p.action.name, p.action.args ?? {});
      closeOverlay(p.overlay);
    })
    .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
    .child(
      v_flex()
        .flex_1()
        .overflow_hidden()
        .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
        .when(!login && Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
        .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
          .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
            .text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); view.copied = true; cx.notify(); })
            .child(view.copied ? "Copied" : "Copy")))),
    );
}

export default class HerdrCustom extends View {
  init(_props, cx) {
    const supplied = props() ?? {};
    if (typeof supplied.overlay === "string" && typeof supplied.title === "string") {
      this.isToast = true;
      this.toastProps = supplied;
      this.copied = false;
      return;
    }

    // Auto Tabs reads the panel list from shared state. Keep its Changes
    // button and panel restore behavior enabled.
    const panels = shared("workspace.panels");
    if (JSON.stringify(panels) !== JSON.stringify(["changes"])) {
      setShared("workspace.panels", ["changes"]);
    }
  }

  render(cx) {
    if (this.isToast) {
      return renderToast(this.toastProps, theme(), this);
    }
    const t = theme();
    const root = layout();
    const todo = find(root, "todo");
    const agenttrail = find(root, "agenttrail");
    const button = (id, label, icon, on, click) =>
      h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click(click)
        .child(icon).child(label);
    const todoOn = Boolean(todo && !todo.hidden);
    const mapOn = Boolean(agenttrail && !agenttrail.hidden);
    const w = window();
    const windowButton = (id, icon, click) =>
      h_flex().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(click).child(icon);

    return h_flex().size_full().h_full().items_center().gap(3).px(6)
      .bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(todo), (el) => el.child(button(
        "toggle-todo", "To-do", svg("mods/workspace-chrome/check.svg").size(14), todoOn,
        () => run(todoOn ? "layout.hide" : "layout.show", { id: "todo" }),
      )))
      .when(Boolean(agenttrail), (el) => el.child(button(
        "toggle-map", "Map",
        image(settings().dark === false ? "mods/agenttrail/mark-light.svg" : "mods/agenttrail/mark-dark.svg").w(14).h(14).flex_none(),
        mapOn,
        () => run(mapOn ? "layout.hide" : "layout.show", { id: "agenttrail" }),
      )))
      .when(w?.buttons, (el) => el
        .child(windowButton("minimize", w.platform === "windows" ? svg("mods/auto-tabs-custom/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(windowButton("maximize", w.platform === "windows" ? svg(`mods/auto-tabs-custom/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(windowButton("close-window", w.platform === "windows" ? svg("mods/auto-tabs-custom/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
