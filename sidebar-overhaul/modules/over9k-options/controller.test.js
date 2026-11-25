import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import { createNativeTestHost, findNode, trigger } from "../over9k/native-test-host.js";

const host = createNativeTestHost({
  appHome: "/tmp/herdr-options-test",
  focused: { space: "space-1", tab: "tab-1", pane: "pane-1", terminal: "terminal-1" },
  shared: {
    layout: "over9k",
  },
});
let calls = [];
host.herdr.exec = async (command, args) => {
  calls.push({ command, args });
  if (command === "herdr-app") return { code: 0, stdout: "", stderr: "" };
  assert.equal(command, "git");
  if (args.includes("rev-parse") && args.includes("--show-toplevel")) return { code: 0, stdout: "/tmp/checkout\n", stderr: "" };
  if (args.includes("status")) return { code: 0, stdout: " M over9k/mods/over9k-options/main.js\n", stderr: "" };
  throw new Error(`unexpected git call: ${args.join(" ")}`);
};
class TestInputState {
  constructor({ value = "", placeholder = "" } = {}) {
    this.current = String(value);
    this.placeholder = String(placeholder);
    this.handlers = new Map();
    this.focused = false;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  focus() {
    this.focused = true;
    return this;
  }

  value() {
    return this.current;
  }

  set_value(value) {
    this.current = String(value ?? "");
    return this;
  }

  content() {
    return { text: this.current, placeholder: this.placeholder };
  }

  tokens() {
    return [];
  }

  replace_with_token() {}
}

let rendering = false;
let testProps = {};
const gpuiBase = {
  ...host.gpuiBase,
  InputState: { new: (options) => {
    assert.equal(rendering, false, "InputState.new cannot run during render");
    return new TestInputState(options);
  } },
  Input: { new: () => host.gpuiKit.div() },
};

const herdr = {
  ...host.herdr,
  writeTextFile: async () => {},
  props: () => testProps,
  closeOverlay: () => null,
  pickFolder: async () => null,
};

globalThis.localStorage = host.storage;
globalThis.sessionStorage = host.storage;
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => gpuiBase);
mock.module("herdr", () => herdr);

const { default: SidebarOptions } = await import("./main.js");
const { MachineSettingsController } = await import("./machine-settings.js");
function controller() {
  const view = new SidebarOptions();
  view.handle = {};
  view.tab = "options";
  view.page = "machines";
  view.setup = false;
  view.reloading = false;
  view.confirming = false;
  view.reloadCandidate = null;
  view.reloadStatus = "";
  view.reloadResult = null;
  view.reloadRequest = null;
  return view;
}

function eventContext(promises) {
  return {
    notify() {},
    stop_propagation() {},
    open_url() {},
    spawn(fn) {
      const promise = fn(this);
      promises.push(promise);
      return promise;
    },
  };
}

test("standalone local reload checks changed mods, waits for consent, and restores focus without network operations", async () => {
  calls = [];
  const view = controller();
  const firstRender = view.render({ notify() {} });
  assert.ok(findNode(firstRender, "local-reload"), "local reload control is available");
  assert.equal(findNode(firstRender, "update"), null, "the updater card is absent");
  const firstPromises = [];
  trigger(firstRender, "local-reload", "click", {}, eventContext(firstPromises));
  await Promise.all(firstPromises);

  assert.equal(host.state.shared["over9k.update"], undefined);
  assert.equal(view.reloadStatus, "ready");
  assert.deepEqual(view.reloadCandidate.affected, ["over9k-options"]);
  assert.equal(host.state.shared["over9k.reload"], undefined);
  assert.equal(host.calls.run.length, 0, "checking local mods does not reload before consent");

  const confirmRender = view.render({ notify() {} });
  assert.ok(findNode(confirmRender, "reload-confirm"), "reload requires explicit consent");
  assert.equal(findNode(confirmRender, "update"), null, "the updater card stays absent");
  const secondPromises = [];
  trigger(confirmRender, "reload-confirm", "click", {}, eventContext(secondPromises));
  await Promise.all(secondPromises);

  const request = host.state.shared["over9k.reload"];
  assert.equal(request.status, "pending");
  assert.deepEqual(request.affected, ["over9k-options"]);
  assert.deepEqual(host.calls.run.map(({ name, args }) => ({ name, args })), [
    { name: "layout.switch", args: {} },
    { name: "layout.switch", args: { name: "over9k" } },
    { name: "space.select", args: { id: "space-1" } },
    { name: "tab.select", args: { id: "tab-1" } },
    { name: "pane.focus", args: { pane: "pane-1" } },
  ]);
  const networkCommands = ["fetch", "remote", "diff", "log", "merge", "pull", "push"];
  assert.equal(calls.some(({ command, args }) => command === "git" && networkCommands.some((name) => args.includes(name))), false);
  assert.equal(calls.filter(({ command }) => command === "herdr-app").length, 2);
});


const savedConfig = {
  version: 1,
  machines: {
    local: { worktreeDirectory: "/worktrees/local", locations: { chats: "~", projects: "/local-projects" }, projects: { pinned: [], hidden: [], unpinned: [], listed: [] }, options: {} },
    remote: { worktreeDirectory: "/worktrees/remote", locations: { chats: "~/chats", projects: "/workspaces" }, projects: { pinned: [], hidden: [], unpinned: [], listed: [] }, options: {} },
  },
  repositories: {},
  options: {},
};

function machineController(machine = null, connected = []) {
  return new MachineSettingsController({ config: structuredClone(savedConfig), machine, home: "/home/dev", machines: connected.map((name) => ({ name, state: "connected" })) });
}

async function saveMachine(controller, exec = async () => ({ code: 0, stdout: "", stderr: "" })) {
  let config;
  const result = await controller.save({ exec, persist: async (mutator) => {
    config = mutator(structuredClone(controller.config));
    return { config };
  } });
  return { config, result };
}

test("machine drafts save independently and only update dirty fields", async () => {
  const view = machineController();
  view.set("projects", "/new-local");
  view.machine = "remote";
  view.set("handoffRule", true);
  const remote = await saveMachine(view);
  assert.equal(remote.config.machines.remote.options.handoffRule, true);
  assert.equal(remote.config.machines.remote.locations.projects, "/workspaces");
  assert.equal(remote.config.machines.local.locations.projects, "/local-projects");
  assert.equal(view.dirty("remote"), false);
  assert.equal(view.dirty(null), true);
  view.machine = null;
  const local = await saveMachine(view);
  assert.equal(local.config.machines.local.locations.projects, "/new-local");
  assert.equal(local.config.machines.remote.options.handoffRule, true);
});

test("machine tab switching and discard preserve other drafts", () => {
  const view = machineController();
  view.set("chats", "/local-chats");
  view.machine = "remote";
  view.set("handoffRule", true);
  view.discard();
  assert.equal(view.dirty("remote"), false);
  assert.equal(view.draft("remote").handoffRule, false);
  assert.equal(view.dirty(null), true);
  assert.equal(view.draft(null).chats, "/local-chats");
});

test("machine settings reject invalid paths and check connected roots on selected machine", async () => {
  const view = machineController("remote", ["remote"]);
  view.set("worktreeDirectory", "relative");
  await assert.rejects(saveMachine(view), /absolute path/);
  assert.equal(view.dirty(), true);
  view.set("worktreeDirectory", "/missing");
  const calls = [];
  await assert.rejects(saveMachine(view, async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 1 };
  }), /already exist and be writable/);
  assert.equal(calls.every((call) => call.options?.on === "remote"), true);
});

test("offline machine edits preserve stored shorthand unless a location is changed", async () => {
  const view = machineController("remote");
  view.set("keepUpToDate", true);
  const { config } = await saveMachine(view);
  assert.equal(config.machines.remote.locations.chats, "~/chats");
  assert.equal(config.machines.remote.options.keepUpToDate, true);
  view.set("chats", "~/new-chats");
  await assert.rejects(saveMachine(view), /enter an absolute chats path/);
  view.set("chats", "/new-chats");
  const changed = await saveMachine(view);
  assert.equal(changed.config.machines.remote.locations.chats, "/new-chats");
});
test("new offline machine cannot borrow another machine root", async () => {
  const view = new MachineSettingsController({ config: structuredClone(savedConfig), machines: [], home: "/home/dev", machine: "new-machine" });
  view.setConfig({ ...structuredClone(savedConfig), machines: { local: structuredClone(savedConfig.machines.local), remote: structuredClone(savedConfig.machines.remote) } });
  view.set("handoffRule", true);
  assert.equal(view.draft().worktreeDirectory, "");
  await assert.rejects(saveMachine(view), /absolute worktree root/);
  view.set("worktreeDirectory", "/new/worktrees");
  const created = await saveMachine(view);
  assert.equal(created.config.machines["new-machine"].worktreeDirectory, "/new/worktrees");
  assert.equal(created.config.machines.remote.worktreeDirectory, "/worktrees/remote");
});
test("machine settings view exposes machine tabs and preserves isolated drafts across tab switches", () => {
  host.reset({ machines: [{ name: "remote", state: "connected" }] });
  host.herdr.exec = async (command, args) => {
    calls.push({ command, args });
    if (command === "herdr-app") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args.includes("rev-parse")) return { code: 0, stdout: "/tmp/checkout\n", stderr: "" };
    if (command === "git" && args.includes("status")) return { code: 0, stdout: " M over9k/mods/over9k-options/main.js\n", stderr: "" };
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  const view = controller();
  view.config = { config: structuredClone(savedConfig) };
  view.machineSettings = new MachineSettingsController({ config: structuredClone(savedConfig), machines: host.herdr.machines(), home: "/home/dev" });
  view.machineInputs = {};
  view.prepareMachineInputs();
  const cx = { notify() {}, stop_propagation() {}, spawn() {} };
  const root = view.render(cx);
  assert.ok(findNode(root, "machine-tab-local"));
  assert.ok(findNode(root, "machine-tab-remote"));
  view.machineInputs.projects.set_value("/local-edited");
  view.machineInputs.projects.handlers.get("change")({}, cx);
  trigger(root, "machine-tab-remote", "click", {}, cx);
  assert.equal(view.machineSettings.machine, "remote");
  assert.equal(view.machineSettings.draft("local").projects, "/local-edited");
  assert.equal(view.machineSettings.draft("remote").projects, "/workspaces");
});

test("machine discovery toggle saves selected-machine option from the view", async () => {
  host.reset({ machines: [{ name: "remote", state: "connected" }] });
  const view = controller();
  view.config = { config: structuredClone(savedConfig) };
  view.machineSettings = new MachineSettingsController({ config: structuredClone(savedConfig), machines: host.herdr.machines(), home: "/home/dev" });
  view.machineInputs = {};
  view.prepareMachineInputs();
  const root = view.render({ notify() {}, spawn() {} });
  trigger(root, "machine-keepUpToDate", "click", {}, { notify() {} });
  const result = await view.machineSettings.save({
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    persist: async (mutator) => ({ config: mutator(structuredClone(view.machineSettings.config)) }),
  });
  assert.equal(result.config.machines.local.options.keepUpToDate, true);
  assert.deepEqual(result.config.machines.remote.options, {});
});

test("machine settings close confirms dirty drafts from other tabs and Escape is contained", () => {
  const view = controller();
  view.machineSettings = new MachineSettingsController({ config: structuredClone(savedConfig), machines: [], home: "/home/dev" });
  view.machineInputs = {};
  view.prepareMachineInputs();
  view.machineSettings.set("projects", "/local-edited", null);
  view.machineSettings.machine = "remote";
  view.prepareMachineInputs();
  const root = view.render({ notify() {}, spawn() {} });
  const stopped = [];
  const [keyDown] = root.styles.get("on_key_down");
  keyDown({ key: "escape" }, { notify() {}, stop_propagation() { stopped.push(true); } });
  assert.deepEqual(stopped, [true]);
  assert.ok(findNode(view.render({ notify() {}, spawn() {} }), "machine-close-confirm"));
});
