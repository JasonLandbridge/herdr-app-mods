import assert from "node:assert/strict";
import { beforeEach, mock, test } from "bun:test";

let liveAgents;
let liveTerminals;
let activeWindow;
let windowPlatform;
let propsState;
let execCalls;
let runCalls;
let runImpl;
let timerAfterCalls;
let timerAfterCallbacks;
let spawnedTasks;
let execImpl;

function element() {
  return {
    id() { return this; },
    size_full() { return this; },
  };
}

mock.module("gpui-kit", () => ({
  View: class View {},
  div: () => element(),
}));
mock.module("herdr", () => ({
  agents: () => liveAgents,
  terminals: () => liveTerminals,
  focused: () => null,
  window: () => ({ platform: windowPlatform, active: activeWindow }),
  exec: async (command, args, options) => {
    execCalls.push({ command, args, options });
    return execImpl(command, args, options);
  },
  props: () => propsState,
  run: async (command, args) => {
    runCalls.push({ command, args });
    return runImpl(command, args);
  },
}));
const { default: DesktopNotifications } = await import("../mods/desktop-notifications/main.js");

function agent(status, address = "unraid-dev/t7") {
  return {
    address,
    space: "sp1",
    space_name: "acme-api",
    tab: "tb1",
    tab_name: "Fix login redirect",
    title: "Fix login redirect",
    status,
    app: "omp",
    program: { name: "OMP" },
  };
}

function context() {
  return {
    timer: {
      every() {},
      after(ms, callback) {
        timerAfterCalls.push(ms);
        timerAfterCallbacks.push(callback);
        return { cancel() {} };
      },
    },
    spawn(callback) {
      const task = Promise.resolve().then(() => callback(this));
      spawnedTasks.push(task);
      return task;
    },
  };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

async function settle() {
  await flush();
  const tasks = spawnedTasks.splice(0);
  for (const task of tasks) await task;
  if (spawnedTasks.length) await settle();
}

function commandPath(command, args) {
  return args?.[0] === "-c" ? args[1] : command;
}

beforeEach(() => {
  liveAgents = [agent("working")];
  liveTerminals = [];
  activeWindow = false;
  windowPlatform = "linux";
  propsState = {};
  execCalls = [];
  runCalls = [];
  spawnedTasks = [];
  timerAfterCalls = [];
  timerAfterCallbacks = [];
  runImpl = async () => ({ code: 0, stdout: "", stderr: "" });
  execImpl = async (command, args) => {
    const invoked = commandPath(command, args);
    if (invoked === "command -v gdbus") return { code: 1, stdout: "", stderr: "" };
    if (invoked === "command -v notify-send") return { code: 0, stdout: "/usr/bin/notify-send\n", stderr: "" };
    if (command === "notify-send") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
});

test("Linux fallback includes OMP report detail, expires, and focuses on click", async () => {
  execImpl = async (command, args) => {
    const invoked = commandPath(command, args);
    if (invoked === "command -v gdbus") return { code: 1, stdout: "", stderr: "" };
    if (invoked === "command -v notify-send") return { code: 0, stdout: "/usr/bin/notify-send\n", stderr: "" };
    if (command === "notify-send") return { code: 0, stdout: "default\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  liveTerminals = [{ address: "unraid-dev/t7", report: { message: "Permission Required: edit --help" } }];
  const view = new DesktopNotifications();
  view.init({}, context());
  view.render();

  liveAgents = [agent("blocked", "unraid-dev/t7")];
  view.render();
  await settle();

  const notification = execCalls.find((call) => call.command === "notify-send");
  assert.deepEqual(notification, {
    command: "notify-send",
    args: [
      "--app-name=Herdr",
      "--urgency=normal",
      "--expire-time=15000",
      "--hint=boolean:transient:true",
      "--wait",
      "--action=default=Open agent",
      "OMP needs you: Fix login redirect",
      "acme-api / Fix login redirect\nPermission Required: edit --help",
    ],
    options: { timeout: 17000 },
  });
  assert.deepEqual(runCalls, [{ command: "agent.focus", args: { terminal: "unraid-dev/t7" } }]);
});

test("Linux D-Bus notifications close immediately when the agent moves on", async () => {
  let monitorResolve;
  execImpl = async (command, args) => {
    const invoked = commandPath(command, args);
    if (command === "gdbus" && args?.some((arg) => arg.endsWith(".Notify"))) return { code: 0, stdout: "(uint32 42,)\n", stderr: "" };
    if (command === "gdbus" && args?.some((arg) => arg.endsWith(".CloseNotification"))) return { code: 0, stdout: "()\n", stderr: "" };
    if (command === "/bin/sh" && args?.[0] === "-c" && args?.[1]?.startsWith("gdbus monitor")) {
      return new Promise((resolve) => { monitorResolve = resolve; });
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const view = new DesktopNotifications();
  view.init({}, context());
  view.render();

  liveAgents = [agent("blocked")];
  view.render();
  await settle();
  liveAgents = [agent("working")];
  view.render();
  await settle();

  assert.equal(execCalls.some((call) => call.command === "gdbus" && call.args?.some((arg) => arg.endsWith(".CloseNotification")) && call.args?.at(-1) === "42"), true);
  monitorResolve?.({ code: 0, stdout: "", stderr: "" });
});

test("stale Linux D-Bus actions never focus a replacement notification", async () => {
  const monitorResults = [];
  execImpl = async (command, args) => {
    const invoked = commandPath(command, args);
    if (invoked === "command -v gdbus") return { code: 0, stdout: "/usr/bin/gdbus\n", stderr: "" };
    if (command === "gdbus" && args?.some((arg) => arg.endsWith(".Notify"))) {
      const id = execCalls.filter((call) => call.command === "gdbus" && call.args?.some((arg) => arg.endsWith(".Notify"))).length + 40;
      return { code: 0, stdout: `(uint32 ${id},)\n`, stderr: "" };
    }
    if (command === "/bin/sh" && args?.[0] === "-c" && args?.[1]?.startsWith("gdbus monitor")) {
      return new Promise((resolve) => { monitorResults.push(resolve); });
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const view = new DesktopNotifications();
  view.init({}, context());
  view.render();

  liveAgents = [agent("blocked")];
  view.render();
  await settle();
  liveAgents = [agent("working")];
  view.render();
  await settle();
  liveAgents = [agent("blocked")];
  view.render();
  await settle();

  monitorResults[0]?.({ code: 0, stdout: "ActionInvoked (uint32 41, 'default')", stderr: "" });
  await settle();
  assert.deepEqual(runCalls, []);
  monitorResults[1]?.({ code: 0, stdout: "ActionInvoked (uint32 42, 'default')", stderr: "" });
  await settle();
  assert.deepEqual(runCalls, [{ command: "agent.focus", args: { terminal: "unraid-dev/t7" } }]);
});

test("macOS terminal-notifier notifications are removed after 15 seconds", async () => {
  windowPlatform = "macos";
  execImpl = async (command, args) => {
    const invoked = commandPath(command, args);
    if (invoked === "command -v terminal-notifier") return { code: 0, stdout: "/usr/local/bin/terminal-notifier\n", stderr: "" };
    if (invoked === "command -v herdr-app") return { code: 0, stdout: "/usr/local/bin/herdr-app\n", stderr: "" };
    if (command === "terminal-notifier") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const cx = context();
  const view = new DesktopNotifications();
  view.init({}, cx);
  view.render(cx);
  liveAgents = [agent("blocked", "unraid-dev/t7")];
  view.render(cx);
  await settle();

  assert.deepEqual(timerAfterCalls, [15000]);
  timerAfterCallbacks[0]();
  await settle();
  assert.equal(execCalls.some((call) => call.command === "terminal-notifier" && call.args?.[0] === "-remove" && call.args?.[1] === "herdr-agent-unraid-dev/t7"), true);
});
test("focus action failures do not reject notification delivery", async () => {
  execImpl = async (command, args) => {
    const invoked = commandPath(command, args);
    if (invoked === "command -v gdbus") return { code: 1, stdout: "", stderr: "" };
    if (invoked === "command -v notify-send") return { code: 0, stdout: "/usr/bin/notify-send\n", stderr: "" };
    if (command === "notify-send") return { code: 0, stdout: "default\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  runImpl = async () => { throw new Error("focus failed"); };
  const view = new DesktopNotifications();
  view.init({}, context());
  view.render();
  liveAgents = [agent("blocked")];
  view.render();
  await settle();
  assert.deepEqual(runCalls, [{ command: "agent.focus", args: { terminal: "unraid-dev/t7" } }]);
});

test("different agents start Linux notifications without serializing", async () => {
  const releases = [];
  execImpl = async (command, args) => {
    const invoked = commandPath(command, args);
    if (invoked === "command -v gdbus") return { code: 1, stdout: "", stderr: "" };
    if (invoked === "command -v notify-send") return { code: 0, stdout: "/usr/bin/notify-send\n", stderr: "" };
    if (command === "notify-send") return new Promise((resolve) => { releases.push(resolve); });
    return { code: 0, stdout: "", stderr: "" };
  };
  const view = new DesktopNotifications();
  view.init({}, context());
  liveAgents = [agent("working", "agent-a"), agent("working", "agent-b")];
  view.render();
  await settle();
  liveAgents = [agent("blocked", "agent-a"), agent("blocked", "agent-b")];
  view.render();
  await flush();
  assert.equal(execCalls.filter((call) => call.command === "notify-send").length, 2);
  releases.forEach((resolve) => resolve({ code: 0, stdout: "", stderr: "" }));
});
