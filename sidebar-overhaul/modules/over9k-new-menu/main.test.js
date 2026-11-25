import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import { createNativeTestHost, findNode, trigger } from "../over9k/native-test-host.js";

const host = createNativeTestHost();
let scanExec = null;
let menuProps = { overlay: "agent-menu" };
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => ({ ...host.gpuiBase, InputState: { new: ({ value }) => ({ value: () => value, on() {} }) }, Input: {} }));
mock.module("herdr", () => ({
  ...host.herdr,
  writeTextFile: async () => {},
  exec: (...args) => scanExec ? scanExec(...args) : host.herdr.exec(...args),
  props: () => menuProps,
  knownAgents: async () => [],
  closeOverlay() {},
  keys: () => [],
  pickFolder() {},
}));
const { default: Menu } = await import("./main.js");
const { publishSidebarConfig, clearSidebarConfigCache } = await import("../../config-store.js");

test("new-agent menu offers only omp and launches it by click or shortcut", () => {
  menuProps = { overlay: "agent-menu" };
  host.reset({ spaces: [{ id: "project", folder: "/work/project", active: true }], layout: {} });
  const view = new Menu();
  view.agents = ["codex", "pi", "omp", "claude"].map((key) => ({
    key, name: key, installed: true, run: [key], icon: `icons/${key}.svg`,
  }));
  view.sessions = {};
  view.handle = {};
  const root = view.render(host.context());

  assert.ok(findNode(root, "omp"));
  for (const key of ["codex", "pi", "claude"]) assert.equal(findNode(root, key), null);
  trigger(root, "omp", "click", {}, host.context());
  const [onKeyDown] = root.styles.get("on_key_down");
  onKeyDown({ key: "1", modifiers: {} }, host.context());
  onKeyDown({ key: "2", modifiers: {} }, host.context());
  assert.deepEqual(host.calls.run, Array.from({ length: 2 }, () => ({
    name: "tab.new", args: { space: "project", folder: "/work/project", name: "omp", argv: ["omp"] },
  })));
});

test("the tab bar menu opens the custom worktree dialog and starts new spaces with OMP", async () => {
  menuProps = { overlay: "agent-menu", tabBar: true };
  host.reset({ spaces: [{ id: "remote", folder: "/workspaces/Reaparr", machine: "unraid-dev", active: true }],
    panes: [{ focused: true, cwd: "/workspaces/Reaparr/src" }] });
  const view = new Menu();
  view.agents = [];
  view.sessions = {};
  view.handle = {};
  const root = view.render(host.context());
  await trigger(root, "worktree", "click", {}, host.context());
  assert.deepEqual(host.calls.openOverlay, [{ mod: "sidebar-overhaul", kind: "dialog", width: 460, height: 280,
    props: { space: "remote", folder: "/workspaces/Reaparr/src", action: "new", view: "worktree" } }]);
  await trigger(root, "space", "click", {}, host.context());
  assert.deepEqual(host.calls.run, [{ name: "space.new", args: { argv: ["bash", "-lc", "exec omp"] } }]);
});

test("clicked remote space wins over active same-folder space", () => {
  menuProps = { overlay: "agent-menu", space: "remote-scripts", folder: "/home/jason/Scripts", machine: "unraid-dev" };
  host.reset({ spaces: [
    { id: "local-scripts", folder: "/home/jason/Scripts", machine: null, active: true },
    { id: "remote-scripts", folder: "/home/jason/Scripts", machine: "unraid-dev", active: false },
  ], layout: {} });
  const view = new Menu();
  view.agents = [{ key: "omp", name: "omp", installed: true, run: ["omp"], icon: "icons/omp.svg" }];
  view.sessions = {};
  view.handle = {};
  const root = view.render(host.context());
  trigger(root, "omp", "click", {}, host.context());
  assert.deepEqual(host.calls.run, [{ name: "tab.new", args: {
    space: "remote-scripts", folder: "/home/jason/Scripts", name: "omp", argv: ["omp"],
  } }]);
});

for (const machine of [null, "unraid-dev"]) test(`manual browsing starts in the configured workspace for ${machine ?? "local"}`, () => {
  host.reset({ shared: {
    "sidebar.options": { locations: { projects: "/local/workspaces" }, computers: { "unraid-dev": { projects: "/remote/workspaces" } } },
    "over9k.locations": { projects: "/old/local" },
    "over9k.remoteLocations": { "unraid-dev": { projects: "/old/remote" } },
  } });
  const view = new Menu();
  view.machine = machine;
  const browsed = [];
  view.browseTo = path => browsed.push(path);
  view.startAdd(host.context());
  const expected = machine ? "/remote/workspaces" : "/local/workspaces";
  assert.equal(view.pathInput.value(), expected);
  assert.deepEqual(browsed, [expected]);
});

test("Add Spaces uses the selected machine’s saved Projects folder over stale shared state", () => {
  host.reset({ shared: { "sidebar.options": { computers: { "unraid-dev": { projects: "/stale" } } } } });
  publishSidebarConfig({ config: { machines: { local: { locations: { projects: "/local" } }, "unraid-dev": { locations: { projects: "/saved" } } } } });
  try {
    const view = new Menu();
    view.machine = "unraid-dev";
    view.browseTo = () => {};
    view.startAdd(host.context());
    assert.equal(view.pathInput.value(), "/saved");
  } finally { clearSidebarConfigCache(); }
});

for (const machine of [null, "unraid-dev"]) test(`scan stays under the configured workspace for ${machine ?? "local"}`, async () => {
  host.reset({ shared: {
    "sidebar.options": { locations: { projects: "/work roots" }, computers: { "unraid-dev": { projects: "~/work roots" } } },
    "projects.autoOn": { "unraid-dev": ["/remote/home/work roots/project"] },
  } });
  const commands = [];
  scanExec = async (command, args, options) => {
    commands.push({ command, args, options });
    return { code: 0, stdout: args[1] === 'printf %s "$HOME"' ? "/remote/home" :
      `${machine ? "/remote/home" : ""}/work roots/project\n/outside/project\n${machine ? "/remote/home" : ""}/work roots-other/project\n` };
  };
  try {
    const view = new Menu();
    view.machine = machine;
    let job;
    view.scan({ spawn: fn => { job = fn({ notify() {} }); } });
    await job;
    const root = machine ? "/remote/home/work roots" : "/work roots";
    assert.deepEqual(view.found, [{ dir: `${root}/project`, unpinned: false }]);
    assert.equal(commands.at(-1).args.at(-1), root);
    assert.deepEqual(commands.at(-1).options, machine ? { on: machine } : {});
  } finally { scanExec = null; }
});

test("opening a manually selected folder starts OMP without duplicating an open space", () => {
  menuProps = { overlay: "agent-menu" };
  host.reset({ spaces: [{ id: "existing", folder: "/work/existing/", active: false }] });
  const view = new Menu();
  view.machine = null;
  view.open("/work/new");
  view.open("/work/existing");
  assert.deepEqual(host.calls.run, [
    { name: "space.new", args: { name: "new", folder: "/work/new", machine: "", argv: ["bash", "-lc", "exec omp"] } },
    { name: "space.select", args: { id: "existing" } },
  ]);
});

test("recent and parked space list validates remote paths and reopens on the selected machine", async () => {
  host.reset({ shared: {
    "sidebar.options": { computers: { remote: { projects: "/workspace" } } },
    "projects.on": { remote: { pinned: ["/parked"] } },
  } });
  menuProps = { computer: true, machine: "remote", overlay: "menu" };
  scanExec = async (command, args, options) => {
    if (command === "herdr-app") return { code: 0, stdout: JSON.stringify({ recent: [{ folder: "/recent", name: "Recent" }, { folder: "/missing" }] }) };
    if (command === "test") { assert.deepEqual(options, { on: "remote" }); return { code: args[1] === "/missing" ? 1 : 0 }; }
    return { code: 0, stdout: args[1] === 'printf %s "$HOME"' ? "/home/dev" : "/workspace/project\n" };
  };
  try {
    const view = new Menu();
    view.machine = "remote";
    let pending;
    view.loadReopen({ spawn: fn => { pending = fn({ notify() {} }); } });
    await pending;
    assert.deepEqual(view.reopen.map(x => x.folder), ["/recent", "/parked", "/workspace/project"]);
    const root = view.reopenList();
    trigger(root, "reopen-/parked", "click", {}, host.context());
    assert.deepEqual(host.calls.run, [{ name: "space.new", args: { name: "parked", folder: "/parked", machine: "remote", argv: ["bash", "-lc", "exec omp"] } }]);
  } finally { scanExec = null; menuProps = { overlay: "agent-menu" }; }
});
