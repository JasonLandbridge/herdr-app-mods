import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import { createNativeTestHost, findNode, textOf } from "./modules/over9k/native-test-host.js";

const host = createNativeTestHost({
  terminals: [{ address: "t-local", state: "live", cwd: "/workspaces/local" }],
});
globalThis.localStorage = host.storage;
globalThis.sessionStorage = host.storage;
let liveProps = {};
let hookFile = null;
const inputState = ({ value = "" } = {}) => ({ value: () => value, set_value(next) { value = next; }, on() {}, focus() {} });
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => ({ ...host.gpuiBase, InputState: { new: inputState }, Input: { new: () => host.gpuiBase.h_flex() }, Scrollbar: { new: () => host.gpuiBase.h_flex(), vertical: () => host.gpuiBase.h_flex() }, VirtualListScrollHandle: class VirtualListScrollHandle {}, v_virtual_list: host.gpuiBase.v_flex }));
mock.module("herdr", () => ({
  ...host.herdr,
  readTextFile: async (path) => path.endsWith("/worktree-hooks.json") ? hookFile : null,
  writeTextFile: async (path, text, expected) => {
    if (!path.endsWith("/worktree-hooks.json")) return;
    assert.equal(expected, hookFile);
    hookFile = text;
  },
  props: () => liveProps,
  keys: () => [],
  knownAgents: () => [],
  layouts: () => [],
  updates: () => [],
  settings: () => ({}),
  closeOverlay: () => null,
  pickFolder: async () => "/tmp",
  themes: () => [],
  hc: async () => ({ code: 0, stdout: "" }),
}));
const { default: SidebarOverhaul } = await import("./main.js");

function testContext() {
  const context = {
    ...host.context(),
    spawn() {},
    focus_handle() { return { focus() {} }; },
  };
  return {
    ...context,
    new(viewClass, props) {
      const view = new viewClass(props);
      view.init?.(props, context);
      return {
        viewClass,
        props,
        view,
        release() {},
        set_props(nextProps) {
          this.props = nextProps;
          this.view.update?.(nextProps);
        },
        render() { return this.view.render(context); },
      };
    },
  };
}

test("native pane menu props render menu actions and survive wrapper updates", () => {
  const wrapper = new SidebarOverhaul();
  const paneProps = { tab: "pane", target: { pane: "p-local", terminal: "t-local" }, overlay: "native-menu" };
  wrapper.init(paneProps, testContext());
  assert.equal(wrapper.view, "menu");
  assert.match(textOf(wrapper.child.render()), /Split right/);
  assert.match(textOf(wrapper.child.render()), /Close pane/);

  const nextPaneProps = { ...paneProps, target: { pane: "p-next", terminal: "t-next" } };
  wrapper.update(nextPaneProps);
  assert.equal(wrapper.view, "menu");
  assert.match(textOf(wrapper.child.render()), /Split right/);
});

test("native terminal-menu lifecycle reads pane props from Herdr props()", () => {
  const wrapper = new SidebarOverhaul();
  liveProps = { tab: "pane", target: { pane: "p-local", terminal: "t-local" }, overlay: "native-overlay" };
  wrapper.init({}, testContext());
  assert.equal(wrapper.view, "menu");
  assert.deepEqual(wrapper.viewProps, liveProps);
  assert.match(textOf(wrapper.child.render()), /Split right/);
});

test("native pane marker overrides inherited sidebar view", () => {
  const wrapper = new SidebarOverhaul();
  const paneProps = { view: "sidebar", tab: "pane", target: { pane: "p-local", terminal: "t-local" }, overlay: "native-overlay" };
  wrapper.init(paneProps, testContext());
  assert.equal(wrapper.view, "menu");
  assert.match(textOf(wrapper.child.render()), /Split right/);
});

test("machine hook editor shows only its machine and saves new rules without altering other machines", async () => {
  const localRule = { machine: null, repo: "/local/Repo", hooks: { on_created: [] } };
  hookFile = JSON.stringify({ version: 2, projects: [localRule] });
  liveProps = { view: "worktree-settings", machine: "unraid-dev" };
  host.state.machines = [{ name: null }, { name: "unraid-dev" }];
  try {
    const wrapper = new SidebarOverhaul();
    const cx = testContext();
    wrapper.init(liveProps, cx);
    const view = wrapper.child.view;
    await view.load(cx);
    assert.match(textOf(wrapper.child.render()), /No saved rules/);
    assert.equal(findNode(wrapper.child.render(), "rule-0"), null);
    view.addRule(cx);
    view.setField("rule-repo", "/workspaces/Reaparr");
    await view.save(cx);
    assert.deepEqual(JSON.parse(hookFile).projects, [localRule,
      { machine: "unraid-dev", repo: "/workspaces/Reaparr", hooks: { on_created: [] } }]);
  } finally {
    liveProps = {};
    hookFile = null;
    host.state.machines = [];
  }
});
