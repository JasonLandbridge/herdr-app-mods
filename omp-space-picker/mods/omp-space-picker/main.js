import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, run, props, closeOverlay, theme } from "herdr";

const OMP = ["bash", "-lc", "exec omp"];

function folderLabel(folder) {
  return (folder ?? "").replace(/\/+$/, "") || "~";
}

function details(space) {
  return [
    folderLabel(space.folder),
    space.branch ? `⎇ ${space.branch}` : "",
    space.machine ? `on ${space.machine}` : "",
  ].filter(Boolean).join("  ·  ");
}

export default class OmpSpacePicker extends View {
  init(_props, cx) {
    this.query = "";
    this.input = InputState.new({ placeholder: "Filter projects and spaces…" });
    this.input.on("change", (_event, cx) => {
      this.query = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_event, cx) => this.open(this.filtered()[this.at], cx));

    this.handle = cx.focus_handle();
    this.handle.focus();
    this.at = Math.max(0, spaces().findIndex((space) => space.active));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }

  filtered() {
    const query = this.query.trim().toLowerCase();
    return spaces().filter((space) => {
      if (!query) return true;
      return [space.name, space.folder, space.branch, space.machine]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  open(space) {
    if (!space || this.opening) return;
    this.opening = true;
    const overlay = props()?.overlay;
    closeOverlay(overlay);
    if (!space.active) run("space.select", { id: space.id });
    run("tab.new", { space: space.id, folder: space.folder, argv: OMP });
  }

  render() {
    const t = theme();
    const rows = this.filtered();
    const selected = rows.length ? Math.min(this.at, rows.length - 1) : 0;
    const rowHeight = 42;

    return v_flex()
      .id("omp-space-picker")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((event, cx) => {
        if (event.key === "escape") this.close();
        else if (event.key === "down" && rows.length) this.at = (selected + 1) % rows.length;
        else if (event.key === "up" && rows.length) this.at = (selected + rows.length - 1) % rows.length;
        else if (event.key === "enter") this.open(rows[selected]);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Open oh-my-pi in…"))
          .child(
            div()
              .id("omp-space-picker-esc")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((style) => style.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("omp-space-list")
          .h(Math.min(360, Math.max(rowHeight, rows.length * rowHeight)))
          .min_h(0)
          .overflow_y_scrollbar()
          .children(
            rows.length
              ? rows.map((space, index) =>
                h_flex()
                  .id(`omp-space-${index}`)
                  .h(rowHeight)
                  .px(10)
                  .gap(10)
                  .items_center()
                  .rounded(7)
                  .cursor_pointer()
                  .when(index === selected, (style) => style.bg(t.selected))
                  .hover((style) => style.bg(t.hover))
                  .on_click(() => this.open(space))
                  .child(div().size(8).flex_none().rounded(4).bg(space.active ? t.accent : t.border))
                  .child(
                    v_flex()
                      .flex_1()
                      .min_w(0)
                      .child(
                        div()
                          .truncate()
                          .text_color(t.foreground)
                          .when(space.active, (style) => style.font_semibold())
                          .child(space.name || folderLabel(space.folder)),
                      )
                      .child(div().truncate().text_size(11.5).text_color(t.dim).child(details(space))),
                  )
                  .child(
                    div()
                      .flex_none()
                      .text_size(11)
                      .text_color(space.active ? t.accent : t.dim)
                      .child(space.active ? "current" : ""),
                  ),
              )
              : [div().p(10).text_color(t.muted).child("No matching projects or spaces")],
          ),
      )
      .child(div().text_size(11).text_color(t.dim).child("↑/↓ select  ·  Enter open oh-my-pi  ·  Esc close"));
  }
}
