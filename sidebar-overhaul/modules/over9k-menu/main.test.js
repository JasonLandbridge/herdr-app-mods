import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import { childrenOf, createNativeTestHost, textOf, findNode, trigger } from "../over9k/native-test-host.js";
const clipboard = [];
const menuIndex = (view, label) => {
  const index = childrenOf(view.render(cx())).findIndex((child) => textOf(child).includes(label));
  assert.notEqual(index, -1, `menu item not found: ${label}`);
  return index;
};
const chooseMenuItem = (view, label) => view.choose(menuIndex(view, label), cx());

const host = createNativeTestHost({
  agents: [{ address: "t-hidden", title: "Hidden agent", status: "idle" }],
  terminals: [{ address: "t-hidden", created_ms: 10, state: "live", program: { key: "claude", agent: true }, status: "idle" }],
  machines: [{ name: null, layout: "ready" }],
});
let activeProps = {};
globalThis.localStorage = host.storage;
globalThis.sessionStorage = host.storage;
host.herdr.closeOverlay = () => null;
host.herdr.pickFolder = async () => "/workspaces/browse";
const inputState = ({ value = "" } = {}) => ({ value: () => value, set_value(next) { value = next; }, on() {}, focus() {} });
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("herdr", () => ({ ...host.herdr, writeTextFile: async () => {}, props: () => activeProps, keys: () => [], closeOverlay: () => null, pickFolder: async () => "/workspaces/browse", themes: () => [] }));
mock.module("gpui-base", () => ({ ...host.gpuiBase, InputState: { new: inputState }, Input: { new: () => host.gpuiBase.h_flex() } }));
const { default: Menu } = await import("./main.js");
const { publishSidebarConfig, clearSidebarConfigCache } = await import("../../config-store.js");
const cx = () => ({ focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, spawn() {}, write_to_clipboard(value) { clipboard.push(value); } });

test("the sidebar's New space action starts OMP", () => {
  host.reset();
  activeProps = { tab: "global", overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "New space");
  assert.deepEqual(host.calls.run, [{ name: "space.new", args: { argv: ["bash", "-lc", "exec omp"] } }]);
});

test("hidden menu opens close-and-remove confirmation without mutating state", () => {
  host.reset({
    agents: [{ address: "t-hidden", title: "Hidden agent", status: "idle" }],
    terminals: [{ address: "t-hidden", created_ms: 10, state: "live", program: { key: "claude", agent: true }, status: "idle" }],
    machines: [{ name: null, layout: "ready" }],
  });
  activeProps = { tab: "hidden", hidden: { kind: "agent", address: "t-hidden", created_ms: 10 }, overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "Close and remove");
  assert.deepEqual(host.calls.run, []);
  assert.deepEqual(host.calls.shared, []);
  assert.deepEqual(host.calls.openOverlay, [{
    mod: "sidebar-overhaul", kind: "dialog", width: 620, height: 520,
    props: { hidden: activeProps.hidden, view: "close" },
  }]);
});

for (const tab of ["agent", "hidden"]) test(`Copy agent ID preserves the full remote address in the ${tab} menu`, () => {
  host.reset();
  clipboard.length = 0;
  const id = "unraid-dev/t42";
  activeProps = { tab, target: { terminal: id }, hidden: { kind: "agent", address: id }, overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "Copy agent ID");
  assert.deepEqual(clipboard, [id]);
  assert.deepEqual(host.calls.run, []);
});
test("pane menu copies the live pane cwd", () => {
  host.reset({
    spaces: [{ id: "s-local", folder: "/spaces/local", machine: null, tabs: [{ id: "tab-local" }] }],
    panes: [{ pane: "p-local", terminal: "t-local", tab: "tab-local", cwd: "/spaces/local/live" }],
    terminals: [{ address: "t-local", state: "live", cwd: "/stale/terminal" }],
    machines: [{ name: null, layout: "ready" }],
  });
  clipboard.length = 0;
  activeProps = { tab: "pane", target: { pane: "p-local", terminal: "t-local" }, overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "Copy folder path");
  assert.deepEqual(clipboard, ["/spaces/local/live"]);
});

test("space menu copies its first live cwd, then falls back to the stored folder", () => {
  host.reset({
    spaces: [{ id: "s-live", folder: "/spaces/stored", machine: "remote", tabs: [{ id: "tab-live" }] }],
    panes: [{ pane: "p-live", terminal: "t-live", tab: "tab-live", cwd: "/remote/live" }],
    terminals: [{ address: "t-live", state: "live" }],
    machines: [{ name: "remote", layout: "ready" }],
  });
  clipboard.length = 0;
  activeProps = { tab: "space", target: { id: "s-live" }, overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "Copy folder path");
  assert.deepEqual(clipboard, ["/remote/live"]);

  host.reset({
    spaces: [{ id: "s-fallback", folder: "ssh://remote/project", machine: "remote", tabs: [{ id: "tab-fallback" }] }],
    panes: [],
    terminals: [],
    machines: [{ name: "remote", layout: "ready" }],
  });
  clipboard.length = 0;
  activeProps = { tab: "space", target: { id: "s-fallback" }, overlay: "menu-overlay" };
  const fallbackView = new Menu();
  fallbackView.init(activeProps, cx());
  chooseMenuItem(fallbackView, "Copy folder path");
  assert.deepEqual(clipboard, ["ssh://remote/project"]);
});

test("detached agent menu copies the live terminal cwd as-is", () => {
  host.reset({
    agents: [{ address: "t-detached", title: "Detached agent", status: "idle" }],
    terminals: [{ address: "t-detached", state: "live", cwd: "ssh://build-host/work tree", program: { key: "claude", agent: true } }],
    panes: [],
    machines: [{ name: null, layout: "ready" }],
  });
  clipboard.length = 0;
  activeProps = { tab: "agent", target: { terminal: "t-detached" }, overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "Copy folder path");
  assert.deepEqual(clipboard, ["ssh://build-host/work tree"]);
});

test("agent menu opens an internal move dialog for the clicked terminal", () => {
  host.reset({ agents: [{ address: "t-agent", app: "omp", status: "idle" }] });
  activeProps = { tab: "agent", target: { terminal: "t-agent" }, overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "Move to space");
  assert.deepEqual(host.calls.openOverlay, [{
    mod: "sidebar-overhaul", kind: "dialog", width: 0.82, height: 0.8,
    props: { tab: "move", target: { terminal: "t-agent" }, view: "menu" },
  }]);
  assert.deepEqual(host.calls.run, []);
});

for (const machine of [null, "unraid-dev"]) test(`machine menu opens selected machine settings for ${machine ?? "local"}`, () => {
  host.reset();
  activeProps = { tab: "machine", target: { machine }, overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "Machine settings");
  assert.deepEqual(host.calls.openOverlay, [{ mod: "sidebar-overhaul", kind: "dialog", width: 780, height: 640,
    props: { view: "options", page: "machines", computer: machine } }]);
});

test("New worktree opens the repository picker for the machine that was clicked", () => {
  host.reset();
  activeProps = { tab: "machine", target: { machine: "unraid-dev" }, overlay: "menu-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  chooseMenuItem(view, "New worktree");
  assert.deepEqual(host.calls.openOverlay.at(-1)?.props, { view: "machine-worktree", machine: "unraid-dev" });
  assert.deepEqual(host.calls.run, []);
});

test("move picker exposes local and remote destination rows in its allocated scroll area", () => {
  host.reset({
    spaces: [{ id: "source", tabs: [{ id: "source-tab" }] }, { id: "target", name: "Local target", folder: "/local" }, { id: "remote/target", name: "Remote target", folder: "/remote", machine: "remote" }],
    agents: [{ address: "t-agent", app: "omp", space: "source" }],
    panes: [{ terminal: "t-agent", tab: "source-tab" }],
  });
  activeProps = { tab: "move", target: { terminal: "t-agent" }, overlay: "move-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  const root = view.render(cx());
  assert.ok(findNode(root, "move-machine-local"));
  assert.ok(findNode(root, "move-machine-remote"));
  assert.ok(findNode(root, "move-to-target"));
  assert.equal(findNode(root, "move-to-remote/target"), null);
  trigger(root, "move-machine-remote", "click", {}, host.context());
  const remoteRoot = view.render(host.context());
  assert.ok(findNode(remoteRoot, "move-to-remote/target"));
  assert.match(textOf(remoteRoot), /Remote target/);
  assert.ok(findNode(root, "move-targets").styles.has("flex_1"), "scrolling destinations require allocated height");
});

test("move picker renders recent and parked sources", () => {
  host.reset({
    spaces: [{ id: "source", tabs: [{ id: "source-tab" }] }],
    agents: [{ address: "t-agent", app: "omp", space: "source" }],
    panes: [{ terminal: "t-agent", tab: "source-tab" }],
  });
  activeProps = { tab: "move", target: { terminal: "t-agent" }, overlay: "move-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  view.discovered = [{ id: "recent-parked:local:/parked", folder: "/parked", name: "Parked", sources: ["Recent", "Parked"], machine: null, discovered: true }];
  const root = view.render(cx());
  assert.match(textOf(root), /Recent \/ Parked/);
  assert.match(textOf(root), /Creates a space here/);
});

test("move picker provides filter, browse, and workspace guidance", () => {
  host.reset({
    shared: { "sidebar.options": { locations: { projects: "/workspaces" } } },
    spaces: [{ id: "source", tabs: [{ id: "source-tab" }] }, { id: "target", name: "Target", folder: "/workspaces/target" }],
    agents: [{ address: "t-agent", app: "omp", space: "source" }],
    panes: [{ terminal: "t-agent", tab: "source-tab" }],
  });
  activeProps = { tab: "move", target: { terminal: "t-agent" }, overlay: "move-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  const root = view.render(cx());
  assert.ok(findNode(root, "move-browse"));
  assert.match(textOf(root), /Workspace root: \/workspaces/);
  assert.equal(view.filter.value(), "");
});

test("Move Agent shows the saved Projects folder for the selected machine", () => {
  host.reset({ machines: [{ name: "unraid-dev", state: "connected" }],
    spaces: [{ id: "source", tabs: [{ id: "tab" }] }, { id: "unraid-dev/target", folder: "/saved/projects/example", machine: "unraid-dev" }],
    panes: [{ terminal: "t-agent", tab: "tab" }], agents: [{ address: "t-agent", app: "omp", space: "source" }],
    shared: { "sidebar.options": { computers: { "unraid-dev": { projects: "/stale" } } } } });
  activeProps = { tab: "move", target: { terminal: "t-agent" }, overlay: "move-overlay" };
  publishSidebarConfig({ config: { machines: { "unraid-dev": { locations: { projects: "/saved/projects" } } } } });
  try {
    const view = new Menu();
    view.init(activeProps, cx());
    trigger(view.render(cx()), "move-machine-unraid-dev", "click", {}, cx());
    assert.match(textOf(view.render(cx())), /Workspace root: \/saved\/projects/);
  } finally { clearSidebarConfigCache(); }
});

test("move picker groups all destination spaces into machine tabs", () => {
  host.reset({
    spaces: [
      { id: "source", machine: null, tabs: [{ id: "source-tab" }] },
      { id: "local-target", name: "Local target", folder: "/local", machine: null },
      { id: "remote-a", name: "Remote A", folder: "/remote-a", machine: "remote-a" },
      { id: "remote-b", name: "Remote B", folder: "/remote-b", machine: "remote-b" },
    ],
    agents: [{ address: "t-agent", app: "omp", space: "source" }],
    panes: [{ terminal: "t-agent", tab: "source-tab" }],
    terminals: [{ address: "t-agent", state: "live", agent: "omp" }],
    machines: [{ name: "remote-a", layout: "ready" }, { name: "remote-b", layout: "ready" }],
  });
  activeProps = { tab: "move", target: { terminal: "t-agent" }, overlay: "move-overlay" };
  const view = new Menu();
  view.init(activeProps, cx());
  let root = view.render(cx());
  assert.ok(findNode(root, "move-machine-local"));
  assert.ok(findNode(root, "move-machine-remote-a"));
  assert.ok(findNode(root, "move-machine-remote-b"));
  assert.ok(findNode(root, "move-to-local-target"));
  assert.equal(findNode(root, "move-to-remote-a"), null);
  trigger(root, "move-machine-remote-a", "click", {}, cx());
  root = view.render(cx());
  assert.ok(findNode(root, "move-to-remote-a"));
  assert.equal(findNode(root, "move-to-local-target"), null);
});
