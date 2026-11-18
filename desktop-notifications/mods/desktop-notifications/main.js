// desktop-notifications: Herdr's "needs you" and "finished" alerts in the
// system's notification center too (macOS, Linux). Draws nothing: dock it in a
// 0px block. alerts.js decides what to announce; this file delivers it.

import { View, div } from "gpui-kit";
import { agents, terminals, focused, window, exec, props, run } from "herdr";
import { diff } from "./alerts.js";

const BUNDLE = "dev.herdr.app";
const GROUP = "herdr-agent-";
const NOTIFY_MS = 15000;
const EXEC_MS = 17000;
const NOTIFICATIONS = "/org/freedesktop/Notifications";
const NOTIFICATION_IFACE = "org.freedesktop.Notifications";

// Quotes one word for sh. The only dynamic shell text is a numeric D-Bus id or
// a fixed signal pattern; notification text always stays an argv value.
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const gvariantString = (s) => JSON.stringify(String(s));

function reportDetail(terminal) {
  const report = terminal?.report;
  if (typeof report === "string") return report.trim();
  return typeof report?.message === "string" ? report.message.trim() : "";
}

export default class DesktopNotifications extends View {
  init(_props, cx) {
    this.cx = cx;
    this.known = null;
    this.sender = null; // "terminal-notifier" | "osascript" | "gdbus" | "notify-send" | "none"
    this.platform = null;
    this.app = null; // herdr-app's path, for click-to-focus
    this.active = new Map(); // address -> the current notification token
    this.sequence = 0;
    // render runs on every live change; the timer covers a hidden block.
    cx.timer.every(2000, (timerCx) => this.check(timerCx));
  }

  check(cx) {
    let live;
    try {
      live = agents();
    } catch {
      return;
    }
    const p = props() ?? {};
    const liveTerminals = terminals() ?? [];
    const subAgents = new Set(liveTerminals.filter((t) => t?.parent).map((t) => t.address));
    const details = new Map(
      liveTerminals
        .map((terminal) => [terminal.address, reportDetail(terminal)])
        .filter(([address, detail]) => address && detail),
    );
    const { known, post, clear } = diff(this.known, live, {
      focus: focused(),
      windowActive: window()?.active ?? false,
      subAgents,
      details,
      want: { blocked: p.blocked, done: p.done },
    });
    this.known = known;
    for (const address of clear) this.clear(address);
    for (const n of post) {
      const task = cx?.spawn
        ? cx.spawn((taskCx) => this.postNotification(n, taskCx))
        : this.postNotification(n, cx);
      task?.catch?.((e) => console.log(`desktop-notifications: ${e}`));
    }
  }

  isCurrent(token) {
    return !token.cancelled && this.active.get(token.address) === token;
  }

  cancelExpiry(token) {
    token.expiry?.cancel?.();
    token.expiry = null;
  }

  async invalidate(address) {
    const token = this.active.get(address);
    if (!token) return;
    token.cancelled = true;
    this.active.delete(address);
    this.cancelExpiry(token);
    if (token.sender === "gdbus" && token.id !== null) {
      await this.closeGdbus(token.id);
    } else if (token.sender === "terminal-notifier") {
      await exec("terminal-notifier", ["-remove", GROUP + address]).catch(() => {});
    }
  }

  clear(address) {
    this.invalidate(address).catch((e) => console.log(`desktop-notifications clear: ${e}`));
  }

  async postNotification(n, cx) {
    await this.invalidate(n.address);
    const token = {
      address: n.address,
      id: null,
      sender: null,
      cancelled: false,
      sequence: ++this.sequence,
      expiry: null,
    };
    this.active.set(n.address, token);
    const sender = await this.findSender();
    if (!this.isCurrent(token)) return;
    try {
      if (sender === "gdbus") {
        if (await this.postGdbus(token, n)) return;
        if (await this.has("notify-send")) {
          this.sender = "notify-send";
          await this.postNotifySend(token, n);
        } else {
          this.finish(token);
        }
      } else if (sender === "notify-send") {
        await this.postNotifySend(token, n);
      } else if (sender === "terminal-notifier") {
        await this.postTerminalNotifier(token, n, cx);
      } else if (sender === "osascript") {
        await this.postOsascript(token, n);
      } else {
        this.finish(token);
      }
    } catch (e) {
      console.log(`desktop-notifications ${sender}: ${e}`);
      this.finish(token);
    }
  }

  finish(token) {
    if (!this.isCurrent(token)) return;
    this.cancelExpiry(token);
    token.cancelled = true;
    this.active.delete(token.address);
  }

  async findSender() {
    const platform = window()?.platform;
    if (platform !== this.platform) {
      this.platform = platform;
      this.sender = null;
      this.app = null;
    }
    if (this.sender) return this.sender;
    if (platform === "macos") {
      this.sender = (await this.has("terminal-notifier")) ? "terminal-notifier" : "osascript";
      const found = await exec("/bin/sh", ["-c", "command -v herdr-app"]).catch(() => null);
      this.app = found?.code === 0 ? found.stdout.trim() : null;
    } else if (platform === "linux") {
      if (await this.has("gdbus")) this.sender = "gdbus";
      else if (await this.has("notify-send")) this.sender = "notify-send";
      else this.sender = "none";
    } else {
      this.sender = "none";
    }
    return this.sender;
  }

  async has(command) {
    return (await exec("/bin/sh", ["-c", `command -v ${command}`]).catch(() => ({ code: 1 }))).code === 0;
  }

  async postGdbus(token, n) {
    token.sender = "gdbus";
    const body = n.subtitle ? `${n.subtitle}\n${n.body}` : n.body;
    const result = await exec("gdbus", [
      "call",
      "--session",
      "--dest",
      NOTIFICATION_IFACE,
      "--object-path",
      NOTIFICATIONS,
      "--method",
      `${NOTIFICATION_IFACE}.Notify`,
      gvariantString("Herdr"),
      "0",
      gvariantString(""),
      gvariantString(n.title),
      gvariantString(body),
      "['default', 'Open agent']",
      "{'urgency': <byte 1>, 'transient': <true>}",
      String(NOTIFY_MS),
    ], { timeout: 5000 }).catch(() => null);
    const id = result?.stdout?.match(/uint32\s+(\d+)/)?.[1];
    if (!id) return false;
    token.id = Number(id);
    if (!this.isCurrent(token)) {
      await this.closeGdbus(token.id);
      return true;
    }
    this.watchGdbus(token).catch((e) => console.log(`desktop-notifications monitor: ${e}`));
    return true;
  }

  async watchGdbus(token) {
    const pattern = `ActionInvoked \\(uint32 ${token.id}, 'default'\\)|NotificationClosed \\(uint32 ${token.id},`;
    const command = `gdbus monitor --session --dest ${NOTIFICATION_IFACE} --object-path ${NOTIFICATIONS} | grep -m1 -E ${sh(pattern)}`;
    const result = await exec("/bin/sh", ["-c", command], { timeout: EXEC_MS }).catch(() => null);
    if (!this.isCurrent(token)) return;
    if (result?.stdout?.includes("ActionInvoked")) {
      try {
        await run("agent.focus", { terminal: token.address });
      } catch (e) {
        console.log(`desktop-notifications focus: ${e}`);
      }
      await this.closeGdbus(token.id);
    }
    this.finish(token);
  }

  async closeGdbus(id) {
    if (id === null || id === undefined) return;
    await exec("gdbus", [
      "call",
      "--session",
      "--dest",
      NOTIFICATION_IFACE,
      "--object-path",
      NOTIFICATIONS,
      "--method",
      `${NOTIFICATION_IFACE}.CloseNotification`,
      String(id),
    ], { timeout: 3000 }).catch(() => {});
  }

  async postNotifySend(token, n) {
    token.sender = "notify-send";
    const body = n.subtitle ? `${n.subtitle}\n${n.body}` : n.body;
    const result = await exec("notify-send", [
      "--app-name=Herdr",
      "--urgency=normal",
      "--expire-time=15000",
      "--hint=boolean:transient:true",
      "--wait",
      "--action=default=Open agent",
      n.title,
      body,
    ], { timeout: EXEC_MS }).catch(() => null);
    if (this.isCurrent(token) && result?.stdout?.trim() === "default") {
      try {
        await run("agent.focus", { terminal: token.address });
      } catch (e) {
        console.log(`desktop-notifications focus: ${e}`);
      }
    }
    this.finish(token);
  }

  async postTerminalNotifier(token, n, cx) {
    token.sender = "terminal-notifier";
    const args = ["-title", n.title, "-message", n.body, "-group", GROUP + n.address, "-activate", BUNDLE];
    if (n.subtitle) args.push("-subtitle", n.subtitle);
    if (this.app) args.push("-execute", `${sh(this.app)} do agent.focus ${sh(JSON.stringify({ terminal: n.address }))}`);
    const result = await exec("terminal-notifier", args).catch(() => ({ code: -1 }));
    if (!this.isCurrent(token)) return;
    if (result.code === 0) {
      const timerCx = cx ?? this.cx;
      token.expiry = timerCx?.timer?.after?.(NOTIFY_MS, () => this.expire(token));
      return;
    }
    token.sender = "osascript";
    await this.postOsascript(token, n);
  }

  async postOsascript(token, n) {
    const script = "on run argv\ndisplay notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)\nend run";
    await exec("osascript", ["-e", script, n.title, n.subtitle ?? "", n.body]).catch(() => {});
    this.finish(token);
  }

  expire(token) {
    if (!this.isCurrent(token)) return;
    token.cancelled = true;
    this.active.delete(token.address);
    if (token.sender === "gdbus" && token.id !== null) {
      this.closeGdbus(token.id).catch(() => {});
    } else if (token.sender === "terminal-notifier") {
      exec("terminal-notifier", ["-remove", GROUP + token.address]).catch(() => {});
    }
  }

  render(cx) {
    this.check(cx ?? this.cx);
    return div().id("desktop-notifications").size_full();
  }
}
