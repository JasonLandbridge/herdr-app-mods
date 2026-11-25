// Explicit OMP session recovery. The overlay only reads bounded JSONL headers and
// launches OMP after a person has selected the saved record (and, for an
// unverified record, one validated exact session file).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, closeOverlay, exec, home, panes, props, run, setShared, shared, spaces, terminals, theme } from "herdr";
import {
  RECOVERY_STATE,
  RecoveryController,
  recoveryRecords,
  selectedRecoveryRecord,
  sessionRoot,
} from "./recovery-controller.js";
import {
  displayTitle,
  isOmpRecord,
  normalizePath,
  recordAgent,
  recordScope,
} from "./session-metadata.js";

const host = () => ({
  exec,
  run,
  shared,
  setShared,
  spaces: () => spaces() ?? [],
  panes: () => panes() ?? [],
  terminals: () => terminals() ?? [],
  agents: () => agents() ?? [],
});

const value = (item) => typeof item === "string" && item.trim() ? item.trim() : null;
const ownerText = (owner = {}) => [value(owner.name), value(owner.id), value(owner.folder)].filter(Boolean).join(" · ") || "not recorded";
const visualText = (visual = {}) => [value(visual.label), value(visual.key), value(visual.machine), value(visual.folder)].filter(Boolean).join(" · ") || "not recorded";
const machineText = (machine) => value(machine) ?? "This computer";

export default class Recovery extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.controller = new RecoveryController(host());
    this.records = recoveryRecords(shared(RECOVERY_STATE));
    this.selectedKey = value(p.recordKey);
    this.machine = value(p.machine);
    this.folder = normalizePath(p.folder);
    this.label = value(p.label);
    this.pending = null;
    this.candidates = [];
    this.rejected = [];
    this.busy = false;
    this.error = "";
    this.notice = "";
    this.pathText = "";
    this.input = InputState.new({ value: "", placeholder: "Absolute OMP .jsonl path" });
    this.input.on("change", (_event, ownCx) => {
      this.pathText = this.input.value();
      this.error = "";
      this.notice = "";
      this.pending = null;
      ownCx.notify();
    });
    this.input.on("submit", (_event, ownCx) => this.validateExplicitPath(ownCx));
    this.input.on("focus", (_event, ownCx) => { this.inputFocused = true; ownCx.notify(); });
    this.input.on("blur", (_event, ownCx) => { this.inputFocused = false; ownCx.notify(); });
    this.inputFocused = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (Array.isArray(p.recordKeys) && p.recordKeys.length) {
      const keys = new Set(p.recordKeys);
      const records = this.records.filter(record => keys.has(record.key)
        && (record.machine ?? null) === this.machine);
      this.busy = true;
      this.notice = `Restoring ${records.length} saved OMP sessions…`;
      cx.spawn(async ownCx => {
        const result = await this.controller.restoreGroup(records);
        this.busy = false;
        if (result.ok) closeOverlay(props().overlay);
        else {
          this.error = result.results.filter(item => !item.ok).map(item => `${item.key}: ${item.error}`).join("\n");
          this.notice = "Some sessions could not be restored; their saved history was preserved.";
          ownCx.notify();
        }
      });
    }
  }

  selected() {
    return selectedRecoveryRecord(this.records, this.selectedKey, {
      machine: this.machine,
      folder: this.folder,
      label: this.label,
    });
  }

  scope(record) {
    return recordScope(record, { machine: this.machine, folder: this.folder });
  }

  chooseRecord(key, cx) {
    this.selectedKey = key;
    this.pending = null;
    this.candidates = [];
    this.rejected = [];
    this.error = "";
    this.notice = "";
    cx.notify();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  discover(cx) {
    const record = this.selected();
    if (!record || !isOmpRecord(record) || record.verified || this.busy) return;
    const scope = this.scope(record);
    const root = sessionRoot(record, { machine: scope.machine, folder: this.folder, home: home() });
    if (!scope.cwd) {
      this.error = "The original working folder is missing; session discovery is scoped and cannot continue.";
      cx.notify();
      return;
    }
    if (!root) {
      this.error = "No OMP session folder is recorded for this legacy session.";
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = "";
    this.notice = "Reading OMP headers only…";
    cx.notify();
    cx.spawn(async (ownCx) => {
      const remoteDefault = Boolean(scope.machine && !record.sessionPath && !record.sessionRoot);
      const effectiveRoot = remoteDefault ? await this.controller.remoteSessionRoot(scope.machine) : root;
      const result = !effectiveRoot
        ? { ok: false, error: "The remote OMP session folder is unavailable; provide an exact path to validate." }
        : await this.controller.discover({ root: effectiveRoot, machine: scope.machine, cwd: scope.cwd, sessionId: record.sessionId }).catch((error) => ({ ok: false, error: `Couldn't enumerate OMP sessions: ${String(error)}` }));
      this.busy = false;
      if (result.ok) {
        this.candidates = result.candidates;
        this.rejected = result.rejected;
        this.notice = this.candidates.length ? `${this.candidates.length} validated session${this.candidates.length === 1 ? "" : "s"} found. Select one to continue.` : "No matching OMP session headers found.";
        this.error = "";
      } else {
        this.candidates = [];
        this.rejected = [];
        this.notice = "";
        this.error = result.error;
      }
      ownCx.notify();
    });
  }

  selectCandidate(candidate, cx) {
    this.pending = candidate ? { ...candidate, selected: true } : null;
    this.error = "";
    this.notice = candidate ? `Validated ${candidate.path}. Confirm before restoring.` : "";
    cx.notify();
  }

  validateExplicitPath(cx) {
    const record = this.selected();
    if (!record || !isOmpRecord(record) || record.verified || this.busy) return;
    const path = normalizePath(this.pathText);
    const scope = this.scope(record);
    if (!path) {
      this.error = "Enter an exact absolute .jsonl path.";
      cx.notify();
      return;
    }
    if (!scope.cwd) {
      this.error = "The original working folder is missing; the exact path cannot be validated.";
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = "";
    this.notice = "Validating the OMP header only…";
    cx.notify();
    cx.spawn(async (ownCx) => {
      const header = await this.controller.readHeader(path, { machine: scope.machine, sessionId: record.sessionId, cwd: scope.cwd }).catch((error) => ({ ok: false, error: `Couldn't read the OMP session header: ${String(error)}` }));
      this.busy = false;
      if (header.ok) {
        this.pending = { path, header, title: displayTitle({}, header), selected: true };
        this.notice = `Validated ${path}. Confirm before restoring.`;
        this.error = "";
      } else {
        this.pending = null;
        this.notice = "";
        this.error = header.error;
      }
      ownCx.notify();
    });
  }

  restore(cx) {
    const record = this.selected();
    if (!record || !isOmpRecord(record) || this.busy) return;
    const exactPath = record.verified ? record.sessionPath : this.pending?.path;
    const confirmed = record.verified || this.pending?.selected === true;
    if (!exactPath || !confirmed) {
      this.error = "Select and confirm one validated OMP session before restoring.";
      cx.notify();
      return;
    }
    const scope = this.scope(record);
    this.busy = true;
    this.error = "";
    this.notice = "Validating the OMP header before opening…";
    cx.notify();
    cx.spawn(async (ownCx) => {
      const result = await this.controller.restore(record, {
        path: exactPath,
        confirm: confirmed,
        machine: scope.machine,
        folder: scope.cwd,
      }).catch((error) => ({ ok: false, error: `Couldn't restore the OMP session: ${String(error)}` }));
      this.busy = false;
      if (!result.ok) {
        this.notice = "";
        this.error = result.error;
        ownCx.notify();
        return;
      }
      closeOverlay(props()?.overlay);
    });
  }

  key(event, cx) {
    if (event.key === "escape") {
      this.close();
      cx.stop_propagation();
    }
  }

  button(t, id, label, primary, enabled, action) {
    return h_flex().id(id).h(30).px(10).items_center().justify_center().rounded(7).flex_none().cursor_pointer()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_size(11.5).text_color(primary ? t.solid_foreground : enabled ? t.foreground : t.dim)
      .when(!enabled, (el) => el.opacity(0.55))
      .when(enabled, (el) => el.hover((s) => s.opacity(0.88)).on_click((_event, ownCx) => action(ownCx)))
      .child(label);
  }

  line(t, label, text) {
    return h_flex().min_h(22).gap(8).items_start()
      .child(div().w(112).flex_none().text_size(11).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground).child(text || "not recorded"));
  }

  recordRow(record, t) {
    const selected = record.key === this.selectedKey;
    const status = record.verified ? "verified OMP" : isOmpRecord(record) ? "unverified OMP" : `${recordAgent(record)} unsupported`;
    return h_flex().id(`record-${record.key}`).min_h(38).px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_event, ownCx) => this.chooseRecord(record.key, ownCx))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(record.title))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${machineText(record.machine)} · ${record.cwd || "folder unknown"}`)))
      .child(div().flex_none().text_size(10).text_color(record.verified ? t.accent : t.dim).child(status));
  }

  details(t, record) {
    const scope = this.scope(record);
    const support = isOmpRecord(record);
    const root = sessionRoot(record, { machine: scope.machine, folder: this.folder, home: home() });
    const canDiscover = support && !record.verified && Boolean(scope.cwd && root) && !this.busy;
    const canRestore = support && !this.busy && (record.verified || Boolean(this.pending?.selected));
    return v_flex().flex_none().gap(6)
      .child(div().pt(4).text_size(13).font_semibold().text_color(t.foreground).child(displayTitle(record)))
      .child(this.line(t, "Original machine", machineText(scope.machine)))
      .child(this.line(t, "Original cwd", scope.cwd || "not recorded"))
      .child(this.line(t, "Actual owner", record.ephemeral ? "no saved agent identity" : ownerText(record.owner)))
      .child(this.line(t, "Visual group", visualText(record.visual)))
      .when(!support, (el) => el.child(div().mt(4).p(8).rounded(7).bg(t.raised).text_size(11.5).text_color(t.warning ?? t.dim)
        .child(`Unsupported agent record (${recordAgent(record)}). It will not be sent to OMP.`)))
      .when(support && record.verified, (el) => el.child(div().mt(4).p(8).rounded(7).bg(t.raised).text_size(11.5).text_color(t.dim)
        .child("Verified OMP identity is checked from the session header before opening.")))
      .when(support && !record.verified, (el) => el
        .child(div().mt(4).p(8).rounded(7).bg(t.raised).text_size(11.5).text_color(t.dim)
          .child(record.ephemeral
            ? "Scoped group recovery has no saved agent identity. Discovery is limited to the supplied machine and folder; no newest-session choice is made."
            : "This legacy record is not verified. Discovery is limited to the original machine and folder; no newest-session choice is made."))
        .child(h_flex().gap(8).items_center()
          .child(this.button(t, "find-sessions", this.busy ? "Reading…" : "Find matching sessions", false, canDiscover, (ownCx) => this.discover(ownCx)))
          .child(div().flex_1().min_w(0).text_size(10.5).text_color(t.dim).truncate().child(root || "session folder unavailable")))
        .child(h_flex().gap(6).items_center()
          .child(Input.new(this.input).flex_1().h(30).px(8).rounded(7).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(11.5).text_color(t.foreground))
          .child(this.button(t, "validate-path", "Validate path", false, !this.busy, (ownCx) => this.validateExplicitPath(ownCx))))
        .when(Boolean(this.candidates.length), (el) => el.child(v_flex().id("session-candidates").h(128).flex_none().overflow_y_scrollbar().gap(3)
          .children(this.candidates.map((candidate, index) => h_flex().id(`candidate-${index}`).min_h(28).px(6).gap(8).items_center().rounded(6)
            .when(this.pending?.path === candidate.path, (row) => row.bg(t.selected))
            .child(v_flex().flex_1().min_w(0).child(div().truncate().text_size(10.5).text_color(t.foreground).child(candidate.title || candidate.path))
              .child(div().truncate().text_size(9.5).text_color(t.dim).child(candidate.path)))
            .child(this.button(t, `select-candidate-${index}`, this.pending?.path === candidate.path ? "Selected" : "Select", false, !this.busy, (ownCx) => this.selectCandidate(candidate, ownCx)))))))
        .when(Boolean(this.rejected.length), (el) => el.child(v_flex().gap(2).child(div().text_size(10).text_color(t.dim).child(`${this.rejected.length} other file${this.rejected.length === 1 ? "" : "s"} rejected by header validation.`)).child(div().truncate().text_size(10).text_color(t.warning ?? t.dim).child(`${this.rejected[0]?.path || "file"}: ${this.rejected[0]?.error || "Header validation failed."}`)))))
      .when(Boolean(this.notice), (el) => el.child(div().pt(4).text_size(11).text_color(t.dim).child(this.notice)))
      .when(Boolean(this.error), (el) => el.child(div().pt(4).text_size(11).text_color(t.warning ?? t.dim).child(this.error)))
      .child(h_flex().pt(8).gap(8).justify_end()
        .child(this.button(t, "cancel", "Cancel", false, true, () => this.close()))
        .when(support, (el) => el.child(this.button(t, "restore", record.verified ? "Restore verified session" : "Confirm restore", true, canRestore, (ownCx) => this.restore(ownCx)))));
  }

  render(cx) {
    const t = theme();
    const record = this.selected();
    return v_flex().id("recovery").track_focus(this.handle).on_key_down((event, ownCx) => this.key(event, ownCx))
      .size_full().min_h(0).p(16).gap(8).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(this.label || "Recover OMP sessions"))
        .child(div().text_size(10.5).text_color(t.dim).child("Esc")))
      .child(div().text_size(11.5).text_color(t.dim).child("Saved records are history only. Choose one explicitly; recovery does not recreate a previous process."))
      .child(v_flex().id("records").h(150).flex_none().overflow_y_scrollbar().gap(3).rounded(7).border_1().border_color(t.border).p(4)
        .when(!this.records.length, (el) => el.child(div().p(6).text_size(11.5).text_color(t.dim).child("No saved recovery records.")))
        .children(this.records.map((item) => this.recordRow(item, t))))
      .when(!record, (el) => el.child(div().flex_1().min_h(0).p(8).text_size(11.5).text_color(t.dim).child("Select a saved record to inspect its original machine, folder and owners.")))
      .when(Boolean(record), (el) => el.child(div().id("details-wrap").flex_1().min_h(0).overflow_y_scrollbar().child(this.details(t, record))))
      .when(!record && this.error, (el) => el.child(div().text_size(11).text_color(t.warning ?? t.dim).child(this.error)));
  }
}
