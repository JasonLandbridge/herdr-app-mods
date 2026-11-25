// Over9k's close confirmation. It captures the complete affected agent set,
// rechecks membership before every destructive action, and records recovery
// metadata before publishing any close command.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, shared, setShared } from "herdr";
import { plan, closePlanIdentity, mergeRecoveryState } from "./close-plan.js";
const RECOVERY = "over9k.recovery";
const SUB_CLOSES = "over9k.closeSubs";
const HIDDEN_REMOVALS = "over9k.hiddenRemovals";

const join = (list) => list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default class CloseConfirm extends View {
  init(_props, cx) {
    this.selection = { ...(props() ?? {}) };
    this.plan = plan(this.selection);
    this.notice = this.plan.blocked ? this.plan.error : "";
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  yes(cx = null) {
    const fresh = plan(this.selection);
    if (closePlanIdentity(this.plan) !== closePlanIdentity(fresh)) {
      this.plan = fresh;
      this.notice = fresh.blocked ? fresh.error : "The affected set changed. Review the complete list, then confirm again.";
      this.handle.focus();
      cx?.notify?.();
      return;
    }
    if (fresh.blocked) {
      this.plan = fresh;
      this.notice = fresh.error || "Reconnect before removing this hidden entry.";
      this.handle.focus();
      cx?.notify?.();
      return;
    }
    const p = this.plan = fresh;
    if (!p.requiresConfirmation) return closeOverlay(props()?.overlay);

    // This write must precede all structural closes and the close-many queue.
    setShared(RECOVERY, mergeRecoveryState(shared(RECOVERY), p.affectedAgents));
    if (p.subRows?.length) setShared(SUB_CLOSES, { list: p.subRows, at: Date.now() });
    closeOverlay(props()?.overlay);
    for (const command of p.commands) run(command.name, command.args);
    if (p.hiddenRemoval) {
      const current = Array.isArray(shared(HIDDEN_REMOVALS)) ? shared(HIDDEN_REMOVALS) : [];
      const event = {
        id: `hidden-${Date.now()}-${current.length}`,
        targets: p.hiddenRemoval.targets.map((target) => ({ address: target.address, created_ms: target.created_ms ?? null })),
        recordKeys: [...new Set(p.hiddenRemoval.recordKeys)],
        group: p.hiddenRemoval.group ? {
          key: p.hiddenRemoval.group.key ?? null,
          kind: p.hiddenRemoval.group.kind ?? "project",
          machine: p.hiddenRemoval.group.machine ?? null,
          folder: p.hiddenRemoval.group.folder ?? null,
        } : null,
      };
      setShared(HIDDEN_REMOVALS, [...current, event]);
    }
  }

  agentRow(record, status, t) {
    const owner = [record.owner?.name, record.owner?.folder].filter(Boolean).join(" · ") || "unknown owner";
    const visual = [record.visual?.label, record.visual?.folder].filter(Boolean).join(" · ") || "unknown group";
    const machine = record.machine ?? "This computer";
    return v_flex().id(`affected-${record.key}`).flex_none().py(5).px(7).rounded(6).bg(t.background)
      .child(h_flex().items_center().gap(7)
        .child(div().size(7).rounded(4).bg(t[status] ?? t.dim).flex_none())
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(record.title))
        .child(div().flex_none().text_size(10.5).text_color(t[status] ?? t.dim).child(status ?? "unknown")))
      .child(div().pl(14).text_size(10.5).text_color(t.dim).whitespace_normal()
        .child(`Actual: ${owner} · ${machine}  |  Shown: ${visual}`));
  }
  savedRow(record, t) {
    const owner = [record.owner?.name, record.owner?.folder].filter(Boolean).join(" · ") || "unknown owner";
    const visual = [record.visual?.label, record.visual?.folder].filter(Boolean).join(" · ") || "unknown group";
    const machine = record.machine ?? "This computer";
    return v_flex().id(`saved-${record.key}`).flex_none().py(5).px(7).rounded(6).bg(t.background)
      .child(h_flex().items_center().gap(7)
        .child(div().size(7).rounded(4).bg(t.dim).flex_none())
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(record.title))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("Saved listing")))
      .child(div().pl(14).text_size(10.5).text_color(t.dim).whitespace_normal()
        .child(`Actual: ${owner} · ${machine}  |  Shown: ${visual}`));
  }


  render(cx) {
    const t = theme();
    const p = this.plan;
    const statuses = new Map((p.agentStatuses ?? []).map((item) => [item.address, item.status]));
    const records = p.affectedAgents ?? [];
    const saved = p.hiddenSaved ?? [];
    const hidden = Boolean(p.hiddenRemoval);
    const ends = [p.terminals && plural(p.terminals, "terminal"), p.agents && plural(p.agents, "agent")].filter(Boolean);
    const spaces = (p.spaceNames ?? []).filter(Boolean);
    const summary = hidden
      ? [ends.length ? `Ends ${join(ends)}.` : "", saved.length ? `Removes ${plural(saved.length, "saved listing")}.` : !ends.length ? "Removes the hidden listing." : ""].filter(Boolean).join(" ")
      : [ends.length ? `Ends ${join(ends)}.` : "No agent or terminal is selected.", spaces.length ? `Closes ${join(spaces)}.` : ""].filter(Boolean).join(" ");
    const title = hidden ? (p.label ? `Close and remove ${p.label}?` : "Close and remove hidden entry?") : (p.label ? `Close ${p.label}?` : "Close selected?");
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex()
      .id("over9k-close")
      .track_focus(this.handle)
      .on_key_down((e, keyCx) => {
        if (e.key === "enter") this.yes(keyCx);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        keyCx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(14)
      .gap(9)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(this.notice), (el) => el.child(div().flex_none().rounded(6).bg(t.blocked + "22").text_color(t.blocked).px(8).py(6).child(this.notice)))
      .child(div().flex_none().text_color(t.muted).child(summary))
      .when(records.length + saved.length > 0, (el) => el.child(v_flex().id("affected-agents").flex_1().min_h(0).gap(4).overflow_y_scrollbar()
        .children(records.map((record) => this.agentRow(record, statuses.get(record.address), t)))
        .children(saved.map((record) => this.savedRow(record, t)))))
      .when(records.length + saved.length === 0, (el) => el.child(div().flex_1().min_h(0)))
      .child(h_flex().flex_none().justify_end().gap(8).text_size(12)
        .child(button("no", "Cancel", t.raised, t.foreground, () => closeOverlay(props()?.overlay)))
        .child(button("yes", p.blocked ? "Reconnect required" : this.notice ? "Confirm again" : hidden ? "Close and remove" : "Close", t.solid, t.solid_foreground, (_event, clickCx) => this.yes(clickCx))));
  }
}
