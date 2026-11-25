import assert from "node:assert/strict";
import { afterEach, beforeEach, mock } from "bun:test";
import { test } from "node:test";
import { createNativeTestHost, findNode, textOf, trigger } from "../../../sidebar-overhaul/modules/over9k/native-test-host.js";

const host = createNativeTestHost();
globalThis.localStorage = host.storage;
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => host.gpuiBase);
mock.module("herdr", () => ({ ...host.herdr, settings: () => ({ zoom: 1 }) }));
const { default: Tabs } = await import("./main.js");

const agentProgram = {
  key: "claude",
  name: "Claude Code",
  icon: null,
  tint: false,
  shell: false,
  agent: true,
};
const shellProgram = {
  key: "shell",
  name: "zsh",
  icon: null,
  tint: false,
  shell: true,
  agent: false,
};

function tab(id, name, active = false) {
  return { id, name, named: false, active, status: null, zoomed: false };
}

function panelLayout(hidden = false, active = "files") {
  return {
    children: [
      { id: "panel", hidden },
      { id: "panel-body", active, children: [{ id: "changes", content: { mod: "omnidiff" } }] },
    ],
  };
}

function reset(next = {}) {
  host.reset({
    spaces: [{ id: "space-1", active: true, tabs: [tab("tab-1", "1", true)] }],
    panes: [],
    layout: panelLayout(),
    shared: { "workspace.panels": ["files", "changes"] },
    localStorage: {},
    ...next,
  });
  globalThis.localStorage = host.storage;
}

function renderTabs() {
  const view = new Tabs();
  view.init();
  return { view, root: view.render() };
}

beforeEach(() => reset());
afterEach(() => {
  globalThis.localStorage = host.storage;
});

test("infers, cleans, and truncates titles while filtering paths and user@host values", () => {
  const longTab = tab("long", "1", true);
  const pathTab = tab("path", "2");
  const hostTab = tab("host", "3");
  reset({
    spaces: [{ id: "space-1", active: true, tabs: [longTab, pathTab, hostTab] }],
    panes: [
      {
        tab: "long",
        terminal: "terminal-long",
        title: "✳ 12345678901234567890123456789012345678901234567890",
        program: agentProgram,
      },
      {
        tab: "path",
        terminal: "terminal-path",
        title: "/workspaces/project",
        program: agentProgram,
      },
      {
        tab: "host",
        terminal: "terminal-host",
        title: "dev@remote",
        cwd: "/workspaces/repo/",
        program: shellProgram,
      },
    ],
  });

  const { root } = renderTabs();

  assert.equal(textOf(findNode(root, "tab-long")), "12345678901234567890123456789012345678901234567…");
  assert.equal(textOf(findNode(root, "tab-path")), "Claude Code");
  assert.equal(textOf(findNode(root, "tab-host")), "repo");
});

test("restores a valid panel choice for the active space", () => {
  reset({
    layout: panelLayout(true, "files"),
    localStorage: { panels: JSON.stringify({ "space-1": "changes" }) },
  });

  renderTabs();

  assert.deepEqual(host.calls.run, [
    { name: "layout.select", args: { stack: "panel-body", child: "changes" } },
    { name: "layout.show", args: { id: "panel" } },
  ]);
  assert.equal(host.storage.getItem("panels"), JSON.stringify({ "space-1": "changes" }));
});

test("Changes opens the configured diff mod full-window without changing the active tab or Files panel", () => {
  const { root } = renderTabs();
  trigger(root, "panel-changes", "click", {}, host.context());
  assert.deepEqual(host.calls.openOverlay, [{ mod: "omnidiff", kind: "dialog", modal: true, frame: "none", width: 1, height: 1 }]);
  assert.deepEqual(host.calls.run, []);
  trigger(root, "panel-files", "click", {}, host.context());
  assert.deepEqual(host.calls.run, [{ name: "layout.hide", args: { id: "panel" } }]);
});

test("opening wide Changes replaces a previously open split Changes panel", () => {
  reset({ layout: panelLayout(false, "changes") });
  const { root } = renderTabs();
  trigger(root, "panel-changes", "click", {}, host.context());
  assert.deepEqual(host.calls.run, [{ name: "layout.hide", args: { id: "panel" } }]);
  assert.equal(host.calls.openOverlay[0].mod, "omnidiff");
});

test("falls back to an empty panel state for malformed, array, null, and inaccessible storage", () => {
  const cases = [
    ["malformed JSON", "not-json"],
    ["array JSON", "[]"],
    ["null JSON", "null"],
  ];

  for (const [label, stored] of cases) {
    reset({ localStorage: { panels: stored } });
    renderTabs();
    assert.equal(host.storage.getItem("panels"), JSON.stringify({ "space-1": "files" }), label);
  }

  const writes = [];
  globalThis.localStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem(key, value) {
      writes.push({ key, value });
    },
  };
  renderTabs();
  assert.deepEqual(writes, [{ key: "panels", value: JSON.stringify({ "space-1": "files" }) }]);
});

test("the tab bar plus uses the custom space and worktree menu", () => {
  const { root } = renderTabs();
  trigger(root, "tab-new", "click", {}, host.context());
  assert.deepEqual(host.calls.openOverlay, [{ mod: "sidebar-overhaul", kind: "popup", width: 340, height: 640,
    props: { view: "new-menu", tabBar: true } }]);
});

test("closing an active tab does not also select it", () => {
  const { root } = renderTabs();
  const cx = { stop_propagation() {} };

  trigger(root, "close-tab-1", "mouse_down:left", {}, cx);
  trigger(root, "close-tab-1", "click", {}, cx);

  assert.deepEqual(host.calls.run, [{ name: "tab.close", args: { id: "tab-1" } }]);
  assert.equal(host.calls.run.some(({ name }) => name === "tab.select"), false);
});
