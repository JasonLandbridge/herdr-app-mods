import { randomUUID } from "crypto";
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { checking, closeOverlay, openOverlay, props, shared, setShared, theme } from "herdr";
import { testConnection, loadUsage, redeemCredit, summarize } from "./omniroute.js";
import { footer, settingsDialog, confirmRedeem } from "./ui.js";

const KEY = "herdr-omniroute-usage";
const config = () => ({ url: "", token: "", redemptionEnabled: false, hidden: [], hiddenPopup: [], codexWindow: "session", timeMode: "countdown", dateFormat: "system", ...shared(KEY) });
const sameConnection = (a, b) => a?.url === b.url && a?.token === b.token;
const dialog = (view, width, height, extra = {}) => openOverlay({ mod: KEY, kind: "dialog", width, height, props: { view, ...extra } });

export default class OmniRouteUsage extends View {
  init(_props, cx) {
    this.view = props()?.view;
    this.closed = false;
    if (this.view === "settings") {
      this.settingsTab = "display";
      const cfg = config();
      this.url = InputState.new({ value: cfg.url, placeholder: "https://omniroute.example" });
      this.token = InputState.new({ value: cfg.token, placeholder: "Read-scoped access token" });
      this.redemptionEnabled = cfg.redemptionEnabled;
      this.token.set_masked(true);
      this.url.on("change", (_event, next) => next.notify());
      this.token.on("change", (_event, next) => next.notify());
      return;
    }
    if (this.view === "confirm") {
      cx.timer.every(1000, (next) => next.notify());
      return;
    }
    if (checking()) return;
    cx.timer.every(300_000, (next) => this.refresh(next));
    this.refresh(cx);
  }

  close() { this.closed = true; }

  refresh(cx) {
    const cfg = config();
    if (checking() || !cfg.url || !cfg.token || this.busy) return;
    const previous = sameConnection(this.connection, cfg) ? this.data : undefined;
    this.connection = cfg;
    this.busy = true;
    cx.spawn(async (next) => {
      try {
        const data = await loadUsage(cfg, previous ?? []);
        if (sameConnection(cfg, config())) { this.data = data; this.error = null; }
      } catch (error) {
        if (sameConnection(cfg, config())) this.error = error.message;
      } finally {
        this.busy = false;
        this.connection = cfg;
        next.notify();
      }
    });
  }

  test(cx) {
    if (this.busy) return;
    const candidate = { url: this.url.value().trim(), token: this.token.value().trim(), redemptionEnabled: this.redemptionEnabled };
    this.busy = true;
    this.error = null;
    this.verified = null;
    cx.notify();
    cx.spawn(async (next) => {
      try {
        await testConnection(candidate);
        if (this.closed || candidate.redemptionEnabled !== this.redemptionEnabled || !sameConnection(candidate, { url: this.url.value().trim(), token: this.token.value().trim() })) return;
        setShared(KEY, { ...config(), ...candidate });
        setShared(`${KEY}:revision`, randomUUID());
        this.verified = candidate;
      }
      catch (error) { this.error = error.message; }
      finally { this.busy = false; next.notify(); }
    });
  }

  updateDisplay(patch, cx) {
    setShared(KEY, { ...config(), ...patch });
    cx.notify();
  }

  redeem(cx) {
    const p = props();
    const cfg = config();
    if (this.busy) return;
    if (!cfg.redemptionEnabled || p.instance !== cfg.url || p.revision !== (shared(`${KEY}:revision`) ?? null)) {
      this.result = "Settings or credits changed. Close this dialog and review the updated list.";
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (next) => {
      try {
        await redeemCredit(cfg, p.account.id, p.credit.selectionToken, randomUUID());
        this.result = "Redemption confirmed.";
      } catch (error) { this.result = error.message; }
      finally {
        setShared(`${KEY}:revision`, randomUUID());
        this.busy = false;
        next.notify();
      }
    });
  }

  showPopup(cx, pinned) {
    this.popupTimer?.cancel();
    this.popupVisible = true;
    this.popupPinned = pinned;
    this.clock ??= cx.timer.every(1000, (next) => next.notify());
    cx.notify();
  }

  closePopup(cx) {
    this.clock?.cancel();
    this.clock = null;
    this.popupTimer?.cancel();
    if (!this.popupVisible) return;
    this.popupVisible = false;
    this.popupPinned = false;
    this.contentHovered = false;
    cx.notify();
  }

  hoverPopup(region, hovered, cx) {
    if (region === "content") this.contentHovered = hovered && this.popupVisible;
    else this.triggerHovered = hovered;
    this.popupTimer?.cancel();
    const inside = this.triggerHovered || this.contentHovered;
    if (this.popupPinned || Boolean(inside) === Boolean(this.popupVisible)) return;
    this.popupTimer = cx.timer.after(inside ? 350 : 300, (next) => {
      this.popupTimer = null;
      if (inside) this.showPopup(next, false);
      else this.closePopup(next);
    });
  }

  render(cx) {
    const t = theme();
    const p = props();
    const cfg = config();
    if (this.view === "settings") return settingsDialog(this, p.providers ?? [], cfg, t, () => closeOverlay(p.overlay));
    if (this.view === "confirm") return confirmRedeem(this, p, cfg, t, () => closeOverlay(p.overlay));
    const revision = shared(`${KEY}:revision`) ?? null;
    const changed = !sameConnection(this.connection, cfg);
    if (changed && this.connection) { this.data = null; this.error = null; }
    if (!this.busy && cfg.url && cfg.token && (changed || this.revision !== revision)) {
      this.revision = revision;
      cx.spawn((next) => this.refresh(next));
    }
    const data = this.data ?? [];
    this.collapsedProviders ??= new Set();
    return footer({ data, hidden: cfg.hidden, hiddenPopup: cfg.hiddenPopup, codexWindow: cfg.codexWindow, summarize,
      configured: Boolean(cfg.url && cfg.token), stale: Boolean(this.error), loading: Boolean(this.busy), error: this.error,
      border: p?.border, timeMode: cfg.timeMode, dateFormat: cfg.dateFormat,
      redemptionEnabled: cfg.redemptionEnabled,
      collapsed: this.collapsedProviders,
      toggleProvider: (id, next) => {
        if (!this.collapsedProviders.delete(id)) this.collapsedProviders.add(id);
        next.notify();
      },
      refresh: (next) => this.refresh(next),
      settings: (next) => {
        this.closePopup(next);
        dialog("settings", 660, 560, { providers: data.map(({ id, label }) => ({ id, label })) });
      },
      redeem: (account, credit, next) => {
        this.closePopup(next);
        dialog("confirm", 430, 205, { account: { id: account.id, label: account.label }, credit, instance: cfg.url, revision });
      },
    }, t, {
      visible: this.popupVisible,
      hover: (region, hovered, next) => this.hoverPopup(region, hovered, next),
      open: (next) => this.showPopup(next, true),
      close: (next) => this.closePopup(next),
    });
  }
}
