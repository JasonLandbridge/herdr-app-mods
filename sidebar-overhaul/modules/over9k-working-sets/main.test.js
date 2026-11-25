import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import {
  createNativeTestHost,
  findNode,
  textOf,
  trigger,
} from "../over9k/native-test-host.js";

const WORKING_SETS = "over9k.workingSets";
const VISIBILITY = "over9k.visibility";
const host = createNativeTestHost();
let activeProps = {};

class TestInputState {
  constructor(options = {}) {
    this.current = String(options.value ?? "");
    this.handlers = new Map();
  }

  static new(options) {
    return new TestInputState(options);
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  value() {
    return this.current;
  }

  set_value(value) {
    this.current = String(value ?? "");
  }

  focus() {}

  emit(event, payload, cx) {
    return this.handlers.get(event)?.(payload, cx);
  }
}

const testGpuiBase = {
  ...host.gpuiBase,
  InputState: TestInputState,
  Input: { new: () => host.gpuiKit.div() },
};
const testHerdr = {
  ...host.herdr,
  props: () => ({ ...activeProps }),
  closeOverlay: () => null,
};
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => testGpuiBase);
mock.module("herdr", () => testHerdr);
const { default: WorkingSets } = await import("./main.js");

const selectors = [
  { key: "d:/work/Alpha", nativeKey: "d:/work/Alpha", label: "Alpha", folder: "/work/Alpha", machine: null, kind: "project" },
  { key: "r:buildbox:/work/Beta", nativeKey: "r:buildbox:/work/Beta", label: "Beta", folder: "/work/Beta", machine: "buildbox", kind: "project" },
  { key: "s:local:/home/dev", nativeKey: "sp-home", label: "Home", folder: "/home/dev", machine: null, kind: "space" },
];
const visibleSelectors = [selectors[0], selectors[1]];
const manualVisibility = {
  version: 1,
  hidden: { "t-alpha": { title: "manual hide" } },
  groups: { "d:/work/Manual": { key: "d:/work/Manual", label: "Manual", kind: "project" } },
  effective: { "t-alpha": true },
  groupEffective: {},
};

function context() {
  const cx = host.context();
  cx.focus_handle = () => ({ focus() {} });
  return cx;
}

function setup(shared = {}) {
  host.reset({
    shared: {
      [WORKING_SETS]: { version: 1, active: null, sets: {} },
      [VISIBILITY]: structuredClone(manualVisibility),
      ...shared,
    },
  });
  activeProps = { overlay: "overlay-1", selectors, visibleSelectors };
  const view = new WorkingSets();
  view.init(activeProps, context());
  return view;
}

function render(view) {
  return view.render(context());
}

function emitInput(view, key, value) {
  const input = view.inputs[key];
  input.set_value(value);
  input.emit("change", {}, context());
}

test("save requires a nonempty name and renders machine-qualified projects without native side effects", () => {
  const view = setup();
  let root = render(view);
  assert.ok(findNode(root, "save-working-set"));
  assert.match(textOf(root), /buildbox/);
  assert.match(textOf(root), /This computer/);

  trigger(root, "save-working-set", "click", {}, context());
  assert.equal(host.state.shared[WORKING_SETS].active, null);
  assert.match(textOf(render(view)), /Enter a name before saving/);

  emitInput(view, "newName", "  Alpha focus  ");
  root = render(view);
  trigger(root, "save-working-set", "click", {}, context());

  const saved = host.state.shared[WORKING_SETS];
  assert.match(saved.active, /^working-set-/);
  assert.equal(saved.sets[saved.active].name, "Alpha focus");
  assert.deepEqual(saved.sets[saved.active].selectors.map((item) => item.key), ["d:/work/Alpha", "r:buildbox:/work/Beta"]);
  assert.deepEqual(host.state.shared[VISIBILITY], manualVisibility);
  assert.deepEqual(host.calls.run, []);
  assert.deepEqual(host.calls.exec, []);
  assert.deepEqual(host.calls.hc, []);
});

test("select, rename, delete, and All projects update only working-set state", () => {
  const initial = {
    [WORKING_SETS]: {
      version: 1,
      active: "alpha",
      sets: {
        alpha: { id: "alpha", name: "Alpha", selectors: [selectors[0]], createdAt: 1, updatedAt: 1 },
        beta: { id: "beta", name: "Beta", selectors: [selectors[1]], createdAt: 2, updatedAt: 2 },
      },
    },
  };
  const view = setup(initial);
  let root = render(view);
  assert.match(textOf(root), /Active: Alpha/);

  trigger(root, "select-working-set-beta", "click", {}, context());
  assert.equal(host.state.shared[WORKING_SETS].active, "beta");
  assert.deepEqual(host.state.shared[VISIBILITY], manualVisibility);

  emitInput(view, "rename:beta", "Beta renamed");
  root = render(view);
  trigger(root, "rename-working-set-beta", "click", {}, context());
  assert.equal(host.state.shared[WORKING_SETS].sets.beta.name, "Beta renamed");

  root = render(view);
  trigger(root, "delete-working-set-beta", "click", {}, context());
  assert.equal(host.state.shared[WORKING_SETS].sets.beta, undefined);
  assert.equal(host.state.shared[WORKING_SETS].active, null);

  root = render(view);
  trigger(root, "select-working-set-alpha", "click", {}, context());
  assert.equal(host.state.shared[WORKING_SETS].active, "alpha");
  root = render(view);
  trigger(root, "all-projects", "click", {}, context());
  assert.equal(host.state.shared[WORKING_SETS].active, null);
  assert.deepEqual(host.state.shared[VISIBILITY], manualVisibility);
  assert.deepEqual(host.calls.run, []);
  assert.deepEqual(host.calls.exec, []);
  assert.deepEqual(host.calls.hc, []);
});
