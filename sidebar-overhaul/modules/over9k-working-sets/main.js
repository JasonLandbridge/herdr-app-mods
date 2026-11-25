import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { closeOverlay, props, setShared, shared, theme } from "herdr";
import {
  WORKING_SETS_STATE,
  deleteWorkingSet,
  normalizeWorkingSetsState,
  renameWorkingSet,
  saveWorkingSet,
  selectWorkingSet,
  visibleGroupSelectors,
  workingSetEntries,
} from "./working-sets.js";

const asSelectors = (value) => visibleGroupSelectors(Array.isArray(value) ? value : []);
const countLabel = (count, singular) => `${count} ${singular}${count === 1 ? "" : "s"}`;

function selectorName(selector) {
  return selector?.label || selector?.folder || selector?.key || "Unnamed project";
}

function selectorMachine(selector) {
  return selector?.machine || "This computer";
}

function selectorKind(selector) {
  return selector?.kind === "space" ? "Space" : "Project";
}

export default class WorkingSets extends View {
  init(initialProps, cx) {
    const supplied = initialProps ?? props() ?? {};
    this.selectors = asSelectors(supplied.selectors);
    this.visibleSelectors = asSelectors(supplied.visibleSelectors);
    this.state = normalizeWorkingSetsState(shared(WORKING_SETS_STATE));
    this.inputs = {};
    this.values = { newName: "" };
    this.renameValues = {};
    this.error = "";
    this.notice = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.ensureInput("newName", "", "Working set name");
    for (const entry of workingSetEntries(this.state)) this.ensureRenameInput(entry);
  }

  ensureInput(key, value, placeholder = "") {
    if (this.inputs[key]) return this.inputs[key];
    const state = InputState.new({ value: String(value ?? ""), placeholder });
    state.on("change", (_event, cx) => {
      if (key === "newName") this.values.newName = state.value();
      else if (key.startsWith("rename:")) this.renameValues[key.slice(7)] = state.value();
      this.error = "";
      if (cx) cx.notify();
    });
    state.on("submit", (_event, cx) => {
      if (key === "newName") this.saveCurrent(cx);
      else if (key.startsWith("rename:")) this.rename(key.slice(7), cx);
    });
    this.inputs[key] = state;
    return state;
  }

  ensureRenameInput(entry) {
    const key = `rename:${entry.id}`;
    if (this.renameValues[entry.id] === undefined) this.renameValues[entry.id] = entry.name;
    return this.ensureInput(key, entry.name, "Rename working set");
  }


  close() {
    closeOverlay(props()?.overlay);
  }

  currentState() {
    return normalizeWorkingSetsState(shared(WORKING_SETS_STATE) ?? this.state);
  }

  commit(next, cx, notice = "") {
    this.state = next;
    setShared(WORKING_SETS_STATE, next);
    this.error = "";
    this.notice = notice;
    if (cx) cx.notify();
  }

  saveCurrent(cx) {
    const name = String(this.inputs.newName?.value() ?? this.values.newName ?? "").trim();
    if (!name) {
      this.error = "Enter a name before saving the visible projects.";
      this.notice = "";
      if (cx) cx.notify();
      return;
    }
    const next = saveWorkingSet(this.currentState(), {
      name,
      selectors: this.visibleSelectors,
    }, Date.now());
    const saved = next.sets[next.active];
    this.ensureRenameInput(saved);
    this.commit(next, cx, `Saved ${saved.name} with ${countLabel(saved.selectors.length, "project")}.`);
    this.values.newName = "";
    this.inputs.newName.set_value("");
  }

  select(id, cx) {
    const current = this.currentState();
    if (!current.sets[id]) {
      this.error = "That working set no longer exists.";
      this.notice = "";
      if (cx) cx.notify();
      return;
    }
    const next = selectWorkingSet(current, id);
    this.commit(next, cx, `Showing ${next.sets[id].name}.`);
  }

  allProjects(cx) {
    const next = selectWorkingSet(this.currentState(), null);
    this.commit(next, cx, "Showing all projects. Manual hides are unchanged.");
  }

  rename(id, cx) {
    const name = String(this.inputs[`rename:${id}`]?.value() ?? this.renameValues[id] ?? "").trim();
    if (!name) {
      this.error = "A working set name cannot be empty.";
      this.notice = "";
      if (cx) cx.notify();
      return;
    }
    const current = this.currentState();
    if (!current.sets[id]) return;
    const next = renameWorkingSet(current, id, name, Date.now());
    this.renameValues[id] = next.sets[id].name;
    this.inputs[`rename:${id}`]?.set_value(next.sets[id].name);
    this.commit(next, cx, `Renamed working set to ${next.sets[id].name}.`);
  }

  delete(id, cx) {
    const current = this.currentState();
    if (!current.sets[id]) return;
    const name = current.sets[id].name;
    const next = deleteWorkingSet(current, id);
    delete this.renameValues[id];
    delete this.inputs[`rename:${id}`];
    this.commit(next, cx, `Deleted ${name}.`);
  }

  key(event, cx) {
    if (event.key !== "escape") return;
    this.close();
    cx.stop_propagation();
  }

  button(t, id, label, action, disabled = false, primary = false) {
    return h_flex()
      .id(id)
      .h(29)
      .px(9)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(6)
      .border_1()
      .border_color(disabled ? t.border : primary ? t.accent : t.input)
      .text_size(11.5)
      .text_color(disabled ? t.dim : primary ? t.foreground : t.muted)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_event, cx) => { if (!disabled) action(cx); })
      .child(label);
  }

  input(t, state) {
    return Input.new(state)
      .h(30)
      .px(8)
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(t.input)
      .bg(t.background)
      .text_size(11.5)
      .text_color(t.foreground);
  }

  selectorRow(selector, index, t) {
    return v_flex()
      .id(`working-set-project-${index}`)
      .flex_none()
      .gap(2)
      .px(7)
      .py(5)
      .rounded(5)
      .when(index % 2 === 1, (el) => el.bg(t.background))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_size(10).text_color(t.accent).child(selectorKind(selector)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(selectorName(selector)))
        .child(div().flex_none().text_size(10.5).text_color(t.muted).child(selectorMachine(selector))))
      .child(div().pl(43).text_size(10).text_color(t.dim).truncate().child(selector.folder || selector.key));
  }

  workingSetRow(entry, t) {
    const active = this.state.active === entry.id;
    const input = this.ensureRenameInput(entry);
    return v_flex()
      .id(`working-set-row-${entry.id}`)
      .flex_none()
      .gap(6)
      .p(7)
      .rounded(6)
      .border_1()
      .border_color(active ? t.accent : t.border)
      .when(active, (el) => el.bg(t.selected))
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(entry.name))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(countLabel(entry.selectors.length, "project")))
        .child(this.button(t, `select-working-set-${entry.id}`, active ? "Active" : "Select", (clickCx) => this.select(entry.id, clickCx), active, !active)))
      .child(h_flex().gap(6).items_center()
        .child(this.input(t, input).flex_1().min_w(0))
        .child(this.button(t, `rename-working-set-${entry.id}`, "Rename", (clickCx) => this.rename(entry.id, clickCx)))
        .child(this.button(t, `delete-working-set-${entry.id}`, "Delete", (clickCx) => this.delete(entry.id, clickCx))));
  }

  render(cx) {
    const t = theme();
    const entries = workingSetEntries(this.state);
    const active = this.state.active ? this.state.sets[this.state.active] ?? null : null;
    const activeLabel = active ? `Active: ${active.name}` : "Active: All projects";
    return v_flex()
      .id("over9k-working-sets")
      .track_focus(this.handle)
      .on_key_down((event, keyCx) => this.key(event, keyCx))
      .size_full()
      .min_h(0)
      .p(14)
      .gap(9)
      .bg(t.popover)
      .text_size(12)
      .text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Working sets"))
        .child(div().text_size(10.5).text_color(t.dim).child("Esc"))
        .child(this.button(t, "close-working-sets", "Close", (_clickCx) => this.close())))
      .child(div().flex_none().text_size(10.8).text_color(t.dim).child("Display-only project filters. Manual project and agent hides are preserved."))
      .child(h_flex().flex_none().gap(7).items_end()
        .child(v_flex().flex_1().gap(4)
          .child(div().text_size(10.8).text_color(t.muted).child("Save current visible projects"))
          .child(this.input(t, this.inputs.newName)))
        .child(this.button(t, "save-working-set", "Save", (clickCx) => this.saveCurrent(clickCx), false, true)))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().text_size(10.8).text_color(t.blocked).child(this.error)))
      .when(Boolean(this.notice), (el) => el.child(div().flex_none().text_size(10.8).text_color(t.dim).child(this.notice)))
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(activeLabel))
        .child(this.button(t, "all-projects", "All projects", (clickCx) => this.allProjects(clickCx))))
      .child(v_flex().id("working-set-list").flex_none().h(145).min_h(0).overflow_y_scrollbar().gap(5)
        .children(entries.map((entry) => this.workingSetRow(entry, t)))
        .when(entries.length === 0, (el) => el.child(div().p(7).text_color(t.dim).child("No saved working sets."))))
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(`Projects (${this.selectors.length})`))
        .child(div().text_size(10.5).text_color(t.dim).child(`Save captures ${countLabel(this.visibleSelectors.length, "currently visible project")}.`)))
      .child(v_flex().id("working-set-projects").flex_1().min_h(0).overflow_y_scrollbar().gap(1).rounded(6).border_1().border_color(t.border)
        .children(this.selectors.map((selector, index) => this.selectorRow(selector, index, t)))
        .when(this.selectors.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No project groups are available in this sidebar frame."))));
  }
}
