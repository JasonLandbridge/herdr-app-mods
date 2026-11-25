import { div, image, svg } from "gpui-kit";
import { Button, Popup, Input, Scrollbar, Switch, h_flex, v_flex } from "gpui-base";
import { providerIconPath } from "./icons.js";
import { summarizeBalances, summarizeCodexFooter } from "./omniroute.js";
import { eventTime, timestampLabel } from "./time.js";

const str = (label, color) => div().text_color(color).child(label);
const caption = (value) => `${Math.round(value)}%`;
const windowLabel = (window) => ({ session: "5-hour", weekly: "Weekly" })[window.id] ?? window.label;
const action = (id, label, cb, t, enabled = true) => div().id(id).px(8).py(4).rounded(4)
  .text_color(enabled ? t.foreground : t.dim).child(label)
  .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_event, cx) => cb(cx)));

function meter(value, t, width = 46) {
  const color = value <= 10 ? t.ansi1 : value <= 30 ? t.ansi3 : t.ansi2;
  return h_flex().flex_none().items_center().gap(4)
    .child(div().w(width).h(4).rounded(2).bg(t.border).overflow_hidden()
      .child(div().w(width * value / 100).h(4).bg(color)))
    .child(str(caption(value), color).whitespace_nowrap());
}

function metrics(provider, model, detail) {
  if (provider.id === "codex" && !detail) {
    const id = model.codexWindow;
    return [{ id, label: id === "mixed" ? "Mixed avg" : windowLabel({ id }), windows: id === "mixed" ? ["session", "weekly"] : [id] }];
  }
  const unique = new Map();
  for (const account of provider.accounts) for (const window of account.windows) {
    unique.set(window.id, { id: window.id, label: windowLabel(window), windows: [window.id] });
  }
  return [...unique.values()];
}

function readings(provider, metricsList, model, t) {
  const codex = provider.id === "codex";
  return metricsList.flatMap((metric) => {
    const value = codex ? summarizeCodexFooter(provider.accounts, metric.windows).value : model.summarize(provider.accounts, metric.windows);
    return value === null ? [] : [h_flex().flex_none().items_center().gap(4)
      .child(str(`${metric.label} ${codex && metric.id === "weekly" ? "weighted avg" : "avg"}`, t.muted).whitespace_nowrap())
      .child(meter(value, t))];
  });
}

const balanceText = ({ currency, amount }) => `${currency} ${amount.toFixed(2)}`;

function providerSummary(provider, model) {
  let best;
  for (const metric of metrics(provider, model, false)) {
    const { value, reporting, total } = provider.id === "codex"
      ? summarizeCodexFooter(provider.accounts, metric.windows)
      : { value: model.summarize(provider.accounts, metric.windows) };
    if (value !== null && (!best || value < best.value)) {
      best = { ...metric, value, coverage: reporting < total ? `${reporting}/${total} accounts` : null };
    }
  }
  return { best, balances: best ? [] : summarizeBalances(provider.accounts) };
}

function footerGroup(provider, model, t) {
  const { best, balances } = providerSummary(provider, model);
  const icon = providerIconPath(provider.id);
  const hint = best ? `${provider.label} · ${best.label} remaining${best.coverage ? ` · ${best.coverage} reporting` : ""}` : balances.length ? `${provider.label} · Sum of reported account balances (shared wallets may be counted twice)` : `${provider.label} · ${provider.id === "codex" ? `${metrics(provider, model, false)[0].label} quota not reported` : "Quota not reported"}`;
  return h_flex().id(`omniroute-footer-${provider.id}`).tooltip(hint).flex_none().items_center().gap(6)
    .child(icon ? image(icon).size(14) : str(provider.label, t.foreground).whitespace_nowrap())
    .child(best ? meter(best.value, t) : str(balances.map(balanceText).join(" · ") || "—", t.muted).whitespace_nowrap());
}

function quotaStatus(account, failed, now) {
  const hasReading = account.windows.length || account.balances.length;
  const age = now - Date.parse(account.fetchedAt);
  const minutes = Math.max(0, Math.floor(age / 60_000));
  const updated = Number.isFinite(age) ? `Updated ${minutes < 1 ? "just now" : `${minutes}m ago`}` : null;
  const stale = hasReading && (failed || account.quotaError || (account.staleAfterMs !== null && age > account.staleAfterMs));
  return [stale && "Stale", updated, !hasReading && !account.quotaError && !failed && "Quota not reported"].filter(Boolean).join(" · ");
}

function accountDetails(account, provider, model, t) {
  const now = Date.now();
  const credits = account.credits.toSorted((a, b) => (Date.parse(a.expiresAt) || Infinity) - (Date.parse(b.expiresAt) || Infinity));
  const next = credits.find((credit) => !Number.isFinite(Date.parse(credit.expiresAt)) || Date.parse(credit.expiresAt) > now);
  const status = quotaStatus(account, model.stale, now);
  const inactive = account.active === false;
  return v_flex().gap(4).pl(8).py(4)
    .when(inactive, (e) => e.opacity(0.55))
    .child(str(inactive ? `${account.label} (inactive)` : account.label, t.foreground).font_semibold())
    .when(status, (e) => e.child(str(status, t.muted)))
    .when(account.quotaError, (e) => e.child(str(`Quota fetch failed: ${account.quotaError}`, t.ansi3)))
    .children((account.balances ?? []).map((balance) => str(`Balance: ${balanceText(balance)}`, t.muted)))
    .children(account.windows.map((window) => {
      const reset = eventTime(window.resetAt, model, now);
      return h_flex().gap(8).items_center().child(str(windowLabel(window), t.muted)).child(meter(window.remaining, t, 65))
        .when(reset, (e) => e.child(str(reset, t.dim)));
    }))
    .when(account.creditError, (e) => e.child(str(`Banked resets: ${account.creditError}`, t.ansi3)))
    .when(!account.creditError && ["codex", "claude", "grok-cli"].includes(provider.id), (e) => e.child(
      h_flex().items_center().gap(8).child(str(`Banked resets: ${account.creditCount}`, t.muted))
        .when(model.redemptionEnabled && provider.id === "codex" && next, (row) => row.child(action(`redeem-${account.id}`, "Redeem next", (cx) => model.redeem(account, next, cx), t, !model.stale && !model.loading)))))
    .children(credits.map((credit, i) => str(`${i + 1}. ${eventTime(credit.expiresAt, model, now, true)}`, t.muted)));
}

function providerDetails(provider, model, t) {
  const collapsed = model.collapsed.has(provider.id);
  const label = `${collapsed ? "Expand" : "Collapse"} ${provider.label}`;
  const { best, balances } = collapsed ? providerSummary(provider, model) : { best: null, balances: [] };
  const hint = best ? `${label} · ${best.label} remaining` : balances.length ? `${label} · Sum of reported account balances` : label;
  return v_flex().flex_none().gap(4).border_t(1).border_color(t.border).pt(6)
    .child(Button.new(`omniroute-group-${provider.id}`).w_full().px(4).py(4).rounded(4).cursor_pointer()
      .accessibility_label(hint).tooltip(hint).hover((e) => e.bg(t.hover))
      .on_click((_event, cx) => model.toggleProvider(provider.id, cx))
      .child(h_flex().items_center().gap(6)
        .child(str(collapsed ? "▸" : "▾", t.muted))
        .child(str(provider.label, t.foreground).font_semibold())
        .child(str(`${provider.accounts.length} ${provider.accounts.length === 1 ? "account" : "accounts"}`, t.dim))
        .when(best, (e) => e.child(meter(best.value, t)))
        .when(best?.coverage, (e) => e.child(str(best.coverage, t.muted)))
        .when(balances.length, (e) => e.child(str(balances.map(balanceText).join(" · "), t.muted)))))
    .when(!collapsed, (e) => e
      .when(provider.accounts.length > 1, (group) => group.children(readings(provider, metrics(provider, model, true), model, t)))
      .children(provider.accounts.map((account) => accountDetails(account, provider, model, t))));
}

function details(model, t, popup) {
  const providers = model.data.filter(({ id }) => !model.hiddenPopup.includes(id));
  return v_flex().w(450).max_h(460).p(12).gap(8).rounded(8).border(1).border_color(t.border).bg(t.popover)
    .shadow_lg().text_size(12).text_color(t.foreground)
    .id("omniroute-popup-content")
    .on_hover((hovered, cx) => popup.hover("content", hovered, cx))
    .on_mouse_down_out((_event, cx) => popup.close(cx))
    .child(h_flex().items_center().gap(8).child(div().flex_1().font_semibold().child("OmniRoute quota remaining"))
      .child(Button.new("omniroute-refresh").size(26).rounded(4).cursor_pointer()
        .disabled(!model.configured || model.loading)
        .accessibility_label(model.loading ? "Refreshing cached usage" : "Reload cached usage")
        .tooltip(model.loading ? "Refreshing cached usage" : "Reload cached usage from OmniRoute")
        .hover((e) => e.bg(t.hover)).on_click((_event, cx) => model.refresh(cx))
        .child(svg("frame/settings/refresh.svg").size(15).text_color(model.loading || !model.configured ? t.dim : t.foreground)))
      .child(Button.new("omniroute-settings").size(26).rounded(4).cursor_pointer()
        .accessibility_label("Settings").tooltip("Settings").hover((e) => e.bg(t.hover))
        .on_click((_event, cx) => model.settings(cx))
        .child(svg("mods/workspace-chrome/settings.svg").size(15).text_color(t.foreground))))
    .when(model.error, (e) => e.child(str(`Fetch failed: ${model.error}`, t.ansi3)))
    .when(providers.length, (e) => e.child(div().relative().flex_none().max_h(385)
      .child(div().id("omniroute-detail-scroll").max_h(385).overflow_y_scroll()
        .child(v_flex().gap(6).pr(10).children(providers.map((provider) => providerDetails(provider, model, t))))
      .child(Scrollbar.vertical("omniroute-detail-scroll").mode("always").absolute().inset_0())))
      .when(!providers.length, (e) => e.child(str(!model.configured ? "Open Settings to connect OmniRoute." : model.loading ? "Loading accounts…" : model.data.length ? "No providers enabled for the popup." : "No provider accounts to display.", t.muted))));
}

export function footer(model, t, popup) {
  const visible = model.data.filter(({ id }) => !model.hidden.includes(id));
  const trigger = h_flex().id("omniroute-footer-trigger").w_full().h(26).min_w(0).px(8).items_center().justify_end().gap(6)
    .cursor_pointer().on_hover((hovered, cx) => popup.hover("trigger", hovered, cx))
    .on_click((_event, cx) => popup.open(cx))
    .when(!visible.length, (e) => e.child(str(model.stale ? "OmniRoute · stale" : "OmniRoute", t.foreground).flex_none().whitespace_nowrap()))
    .when(visible.length, (e) => e.child(h_flex().id("omniroute-footer-scroll").flex_1().min_w(0).overflow_x_scrollbar().items_center()
      .child(h_flex().flex_none().min_w_full().items_center().justify_end().gap(14)
        .children(visible.map((provider) => footerGroup(provider, model, t))))));
  return h_flex().size_full().min_w(0).items_center().bg(t.chrome).text_size(11)
    .when(model.border !== false, (e) => e.border_t(1).border_color(t.border))
    .child(Popup.new("omniroute-popover", trigger).anchor("bottom_right").w_full().min_w(0)
      .when(popup.visible, (e) => e.content(details(model, t, popup))));
}

function visibilitySwitch(view, provider, cfg, key, label, t) {
  const visible = !cfg[key].includes(provider.id);
  return Switch.new(`${key}-${provider.id}`).checked(visible).accessibility_label(`${provider.label}: ${label}`)
    .cursor_pointer().on_change((checked, cx) => view.updateDisplay({ [key]: checked
      ? cfg[key].filter((id) => id !== provider.id)
      : [...cfg[key], provider.id] }, cx))
    .child(h_flex().w(34).h(19).p(2).rounded(10).bg(visible ? t.accent : t.input)
      .when(visible, (e) => e.justify_end()).child(div().size(15).rounded(8).bg(visible ? t.accent_foreground : t.muted)));
}

export function settingsDialog(view, providers, cfg, t, close) {
  const verified = view.verified && view.verified.url === view.url.value().trim() && view.verified.token === view.token.value().trim() && view.verified.redemptionEnabled === view.redemptionEnabled;
  const field = (label, state) => v_flex().gap(4).child(str(label, t.muted)).child(Input.new(state).h(32).text_color(t.foreground));
  const connection = view.settingsTab === "connection";
  const panel = v_flex().flex_1().min_w(0).min_h(0).gap(10).id("omniroute-settings-panel").overflow_y_scrollbar();
  if (connection) {
    panel.child(field("Instance URL", view.url)).child(field("OmniRoute access token", view.token))
      .child(str("Use a read-scoped token for monitoring. Redemption is off by default.", t.muted))
      .child(h_flex().items_center().gap(8).child(str("Allow Codex redemption", t.foreground))
        .child(Switch.new("omniroute-enable-redemption").checked(view.redemptionEnabled).disabled(Boolean(view.busy))
          .accessibility_label("Allow Codex redemption").cursor_pointer().on_change((checked, cx) => {
            view.redemptionEnabled = checked;
            cx.notify();
          }).child(h_flex().w(34).h(19).p(2).rounded(10).bg(view.redemptionEnabled ? t.accent : t.input)
            .when(view.redemptionEnabled, (e) => e.justify_end())
            .child(div().size(15).rounded(8).bg(view.redemptionEnabled ? t.accent_foreground : t.muted)))))
      .child(str("Test connection to save this choice. Enabling redemption requires a write-scoped token.", t.muted))
      .child(str("The token is stored unencrypted in Herdr shared settings. Remote instances require HTTPS.", t.muted))
      .when(view.error, (e) => e.child(str(view.error, t.ansi1)))
      .when(verified, (e) => e.child(str("Connection verified and saved", t.ansi2)))
      .child(h_flex().child(action("omniroute-test", view.busy ? "Testing…" : "Test connection", (cx) => view.test(cx), t, !view.busy)));
  } else if (view.settingsTab === "time") {
    const choices = (key, options) => h_flex().gap(4).flex_wrap().children(options.map(([id, label]) =>
      action(`${key}-${id}`, `${cfg[key] === id ? "●" : "○"} ${label}`, (cx) => view.updateDisplay({ [key]: id }, cx), t)));
    panel.child(str("Reset and expiry display", t.foreground).font_semibold())
      .child(choices("timeMode", [["countdown", "Countdown"], ["timestamp", "Timestamp"]]))
      .child(str("Date and time format", t.foreground).font_semibold())
      .child(choices("dateFormat", [["system", "System"], ["12h", "12-hour"], ["24h", "24-hour"], ["iso", "ISO-style"]]))
      .child(str(`Timestamp preview: ${timestampLabel(Date.now(), cfg.dateFormat)}`, t.muted));
  } else {
    panel.child(str("Provider visibility", t.foreground).font_semibold())
      .child(h_flex().items_center().child(str("Provider", t.muted).flex_1())
        .child(str("Footer", t.muted).w(72)).child(str("Popup", t.muted).w(72)))
      .children(providers.map((provider) => h_flex().items_center().py(4).border_t(1).border_color(t.border)
        .child(str(provider.label, t.foreground).flex_1().min_w(0))
        .child(h_flex().w(72).child(visibilitySwitch(view, provider, cfg, "hidden", "Footer", t)))
        .child(h_flex().w(72).child(visibilitySwitch(view, provider, cfg, "hiddenPopup", "Popup", t)))))
      .when(!providers.length, (e) => e.child(str("Provider choices appear after the first connection.", t.dim)))
      .child(str("Codex footer window", t.foreground).font_semibold())
      .child(h_flex().gap(4).children([["session", "5-hour"], ["weekly", "Weekly"], ["mixed", "Mixed avg"]].map(([id, label]) =>
        action(`window-${id}`, `${cfg.codexWindow === id ? "●" : "○"} ${label}`, (cx) => view.updateDisplay({ codexWindow: id }, cx), t))))
      .child(str("Display changes save automatically.", t.dim));
  }
  return v_flex().size_full().p(16).gap(12).bg(t.popover).text_color(t.foreground)
    .child(div().font_semibold().child("OmniRoute settings"))
    .child(h_flex().flex_1().min_h(0).items_stretch().gap(12)
      .child(v_flex().w(120).flex_none().gap(4).pr(8).border_r(1).border_color(t.border)
        .children([["display", "Display"], ["time", "Date & Time"], ["connection", "Connection"]].map(([id, label]) =>
          action(`settings-tab-${id}`, label, (cx) => { view.settingsTab = id; cx.notify(); }, t).whitespace_nowrap()
            .when(view.settingsTab === id, (e) => e.bg(t.selected).font_semibold()))))
      .child(panel))
    .child(h_flex().justify_end().child(action("omniroute-close-settings", "Close", close, t)));
}

export function confirmRedeem(view, p, cfg, t, close) {
  return v_flex().size_full().p(16).gap(10).bg(t.popover).text_color(t.foreground)
    .child(div().font_semibold().child("Redeem one Codex reset?"))
    .child(str(p.account.label, t.foreground)).child(str(eventTime(p.credit.expiresAt, cfg, Date.now(), true), t.muted))
    .when(view.result, (e) => e.child(str(view.result, t.foreground)))
    .child(h_flex().justify_end().gap(6)
      .child(action("omniroute-redeem-close", view.result ? "Close" : "Cancel", close, t, !view.busy))
      .when(!view.result, (row) => row.child(action("omniroute-confirm", view.busy ? "Redeeming…" : "Redeem", (cx) => view.redeem(cx), t, !view.busy))));
}
