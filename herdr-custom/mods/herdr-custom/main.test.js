import assert from "node:assert/strict";
import { beforeEach, mock, test } from "bun:test";

let layoutState;
let themeState;
let settingsState;
let sharedPanels;
let toastProps;
let runCalls;
let closedOverlays;
let clipboardWrites;
let stopPropagationCalls;
let contextNotifyCalls;

function element() {
  const el = { children: [], callbacks: {}, styles: {} };
  for (const method of [
    "id", "h", "px", "gap", "flex_none", "items_center", "rounded", "text_size", "bg",
    "text_color", "hover", "on_click", "child", "size_full", "h_full", "border_b", "border_color",
    "w", "size", "cursor_pointer", "overflow_hidden", "flex_1", "truncate", "font_semibold",
    "min_w", "tooltip", "py",
  ]) {
    el[method] = (...args) => {
      if (method === "id") el.nodeId = args[0];
      if (method === "child") el.children.push(args[0]);
      if (method === "on_click") el.callbacks.click = args[0];
      if (method === "bg") el.styles.background = args[0];
      if (method === "text_color") el.styles.textColor = args[0];
      return el;
    };
  }
  el.when = (condition, callback) => condition ? callback(el) : el;
  return el;
}

function findElement(node, id) {
  if (node?.nodeId === id) return node;
  for (const child of node?.children ?? []) {
    const found = findElement(child, id);
    if (found) return found;
  }
  return null;
}

function textContent(node) {
  if (typeof node === "string") return node;
  return (node?.children ?? []).map(textContent).join("");
}

mock.module("gpui-kit", () => ({
  View: class View {},
  div: () => element(),
  image: (source) => Object.assign(element(), { imageSource: source }),
  svg: (source) => Object.assign(element(), { svgSource: source }),
}));
mock.module("gpui-base", () => ({ h_flex: () => element(), v_flex: () => element() }));
mock.module("herdr", () => ({
  closeOverlay: (id) => { closedOverlays.push(id); },
  layout: () => layoutState,
  props: () => toastProps,
  run: async (command, args) => {
    runCalls.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  },
  setShared: (_key, value) => {
    sharedPanels = value;
  },
  window: () => ({ platform: "linux", buttons: false }),
  settings: () => settingsState,
  shared: () => sharedPanels,
  theme: () => themeState,
}));
const { default: HerdrCustom } = await import("./main.js");

function resetState() {
  layoutState = { children: [] };
  themeState = {
    selected: "selected", chrome: "chrome", foreground: "foreground", muted: "muted", hover: "hover", border: "border",
    popover: "popover", raised: "raised", blocked: "blocked", working: "working", done: "done", accent: "accent",
  };
  settingsState = { dark: true };
  sharedPanels = ["changes"];
  toastProps = null;
  runCalls = [];
  closedOverlays = [];
  clipboardWrites = [];
  stopPropagationCalls = 0;
  contextNotifyCalls = 0;
}

beforeEach(resetState);

function makeContext() {
  return {
    stop_propagation() {
      stopPropagationCalls++;
    },
    write_to_clipboard(value) {
      clipboardWrites.push(value);
    },
    notify() {
      contextNotifyCalls++;
    },
  };
}

function startToast(props) {
  toastProps = props;
  const cx = makeContext();
  const view = new HerdrCustom();
  view.init({}, cx);
  return { view, cx };
}

test("agent-focus toasts remain visible", () => {
  for (const [kind, level] of [
    ["done", "info"],
    ["info", "info"],
    ["blocked", "error"],
    ["error", "error"],
  ]) {
    resetState();
    const overlay = `overlay-${kind}`;
    const { view, cx } = startToast({
      overlay,
      title: `${kind} title`,
      body: "Agent attention",
      level,
      action: { name: "agent.focus", args: { terminal: `terminal-${kind}` } },
    });
    const root = view.render(cx);
    assert.deepEqual(closedOverlays, []);
    assert.equal(textContent(root).includes(`${kind} title`), true);
    assert.deepEqual(runCalls, []);
  }
});

test("agent-focus toast remains visible", () => {
  const { view, cx } = startToast({
    overlay: "active-agent-overlay",
    title: "Agent finished",
    body: "Agent attention",
    level: "info",
    action: { name: "agent.focus", args: { terminal: "terminal-1" } },
  });
  const root = view.render(cx);
  assert.deepEqual(closedOverlays, []);
  assert.equal(textContent(root).includes("Agent finished"), true);
});

test("agent-focus toast rendering ignores toast titles", () => {
  for (const title of ["Claude finished", "Unrelated error"]) {
    resetState();
    const { view, cx } = startToast({
      overlay: `overlay-${title}`,
      title,
      body: "No title matching is required",
      level: "info",
      action: { name: "agent.focus", args: { terminal: "terminal-1" } },
    });
    const root = view.render(cx);
    assert.deepEqual(closedOverlays, []);
    assert.equal(textContent(root).includes("No title matching is required"), true);
  }
});

test("agent-focus without a nonempty terminal stays visible", () => {
  const { view, cx } = startToast({
    overlay: "empty-terminal-overlay",
    title: "Agent focus unavailable",
    body: "The action has no terminal",
    level: "error",
    action: { name: "agent.focus", args: { terminal: "" } },
  });
  const root = view.render(cx);
  assert.deepEqual(closedOverlays, []);
  assert.equal(root.children.length > 0, true);
  assert.deepEqual(runCalls, []);
});

test("unrelated error and info toasts remain visible and support action or dismissal", () => {
  const actionable = startToast({
    overlay: "error-overlay",
    title: "Unrelated error",
    body: "The operation failed",
    level: "error",
    icon: "icons/error.svg",
    action: { name: "app.open", args: { page: "errors" } },
  });
  const errorRoot = actionable.view.render(actionable.cx);
  assert.equal(textContent(errorRoot).includes("Unrelated error"), true);
  assert.equal(textContent(errorRoot).includes("The operation failed"), true);
  assert.equal(errorRoot.children[0].imageSource, "icons/error.svg");
  errorRoot.callbacks.click();
  assert.deepEqual(runCalls, [{ command: "app.open", args: { page: "errors" } }]);
  assert.deepEqual(closedOverlays, ["error-overlay"]);

  resetState();
  const dismissible = startToast({
    overlay: "info-overlay",
    title: "Informational update",
    body: "Nothing needs doing",
    level: "info",
  });
  const infoRoot = dismissible.view.render(dismissible.cx);
  assert.equal(infoRoot.children[0].styles.background, "accent");
  assert.equal(textContent(infoRoot).includes("Informational update"), true);
  assert.equal(textContent(infoRoot).includes("Nothing needs doing"), true);
  assert.deepEqual(closedOverlays, []);
  infoRoot.callbacks.click();
  assert.deepEqual(runCalls, []);
  assert.deepEqual(closedOverlays, ["info-overlay"]);
});

test("login-copy writes the command and stops propagation without an action", () => {
  const { view, cx } = startToast({
    overlay: "login-overlay",
    title: "Connection problem",
    body: "devbox needs login; run hc machine login devbox",
    level: "error",
  });
  const root = view.render(cx);
  const copy = findElement(root, "toast-login-copy");
  assert.ok(copy);
  assert.equal(textContent(root).includes("devbox needs a login: run"), true);
  assert.equal(textContent(copy), "Copy");
  copy.callbacks.click({}, cx);
  assert.deepEqual(clipboardWrites, ["hc machine login devbox"]);
  assert.equal(stopPropagationCalls, 1);
  assert.equal(contextNotifyCalls, 1);
  assert.deepEqual(runCalls, []);
  assert.deepEqual(closedOverlays, []);
  const updated = view.render(cx);
  assert.equal(textContent(findElement(updated, "toast-login-copy")), "Copied");
});
