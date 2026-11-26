import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, readTextFile, exec, spaces, run, props, closeOverlay, theme } from "herdr";

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
    this.customProjects = [];
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${appHome()}/mods/sidebar-overhaul/sidebar.config.json`);
        const config = text ? JSON.parse(text) : null;
        for (const [key, entry] of Object.entries(config?.machines ?? {})) {
          if (!Array.isArray(entry?.customProjects)) continue;
          for (const folder of entry.customProjects) {
            if (typeof folder !== "string" || !(folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folder))) continue;
            this.customProjects.push({ folder, machine: key === "local" ? null : key, name: folder.split(/[\\/]/).filter(Boolean).at(-1) || folder });
          }
        }
      } catch { this.error = "Could not read extra project folders from Machine settings."; }
      cx.notify();
    });
  }

  filtered() {
    const query = this.query.trim().toLowerCase();
    const open = spaces();
    const key = ({ machine, folder }) => {
      const path = folder ?? "";
      const normalized = (/^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path).replace(/\/+$/, "");
      return JSON.stringify([machine || null, normalized || (path ? "/" : "")]);
    };
    const seen = new Set(open.map(key));
    const custom = this.customProjects.filter(project => {
      const identity = key(project);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    return [...open, ...custom].filter((space) => {
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

  open(space, cx) {
    if (!space || this.opening) return;
    this.opening = true;
    this.error = "";
    if (!space.id) {
      cx.spawn(async cx => {
        try {
          const result = await exec("test", ["-d", space.folder], { on: space.machine ?? undefined });
          if (result.code !== 0) throw new Error("Folder not accessible");
          run("space.new", { machine: space.machine ?? "", folder: space.folder, argv: OMP });
          this.close();
        } catch {
          this.error = `Cannot open ${space.folder} on ${space.machine ?? "this computer"}. Check the folder and connection.`;
          this.opening = false;
          cx.notify();
        }
      });
      return;
    }
    this.close();
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
        else if (event.key === "enter") this.open(rows[selected], cx);
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
                  .on_click((_event, cx) => this.open(space, cx))
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
                      .child(space.active ? "current" : space.id ? "" : "saved folder"),
                  ),
              )
              : [div().p(10).text_color(t.muted).child("No matching projects or spaces")],
          ),
      )
      .when(Boolean(this.error), el => el.child(div().text_color(t.ansi3).child(this.error)))
      .child(div().text_size(11).text_color(t.dim).child("↑/↓ select  ·  Enter open oh-my-pi  ·  Esc close"));
  }
}
