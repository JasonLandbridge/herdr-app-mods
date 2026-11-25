const copy = (value) => {
  if (value === undefined || value === null) return value;
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
};

class TestStorage {
  constructor(initial = {}, calls = null) {
    this.values = new Map(Object.entries(initial));
    this.calls = calls;
  }

  reset(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
    this.calls?.storage.push({ type: "set", key: String(key), value: String(value) });
  }

  removeItem(key) {
    this.values.delete(String(key));
    this.calls?.storage.push({ type: "remove", key: String(key) });
  }

  clear() {
    this.values.clear();
    this.calls?.storage.push({ type: "clear" });
  }
}

class NativeNode {
  constructor(kind, value = null) {
    this.kind = kind;
    this.value = value;
    this.nodeId = null;
    this._children = [];
    this._handlers = new Map();
    this.styles = new Map();
  }

  id(value) {
    this.nodeId = String(value);
    return this;
  }

  child(value) {
    if (value !== null && value !== undefined && value !== false) this._children.push(value);
    return this;
  }

  children(values) {
    for (const value of values ?? []) this.child(value);
    return this;
  }

  when(condition, branch) {
    if (condition) branch(this);
    return this;
  }

  map(transform) {
    return transform(this);
  }

  on_click(handler) {
    this._handlers.set("click", handler);
    return this;
  }

  on_hover(handler) {
    this._handlers.set("hover", handler);
    return this;
  }

  on_mouse_move(handler) {
    this._handlers.set("mouse_move", handler);
    return this;
  }

  on_mouse_down(button, handler) {
    this._handlers.set(`mouse_down:${button}`, handler);
    return this;
  }

  on_mouse_up(button, handler) {
    this._handlers.set(`mouse_up:${button}`, handler);
    return this;
  }
}

const node = (kind, value = null) => new Proxy(new NativeNode(kind, value), {
  get(target, property, receiver) {
    if (property in target) return Reflect.get(target, property, receiver);
    if (typeof property === "symbol") return undefined;
    return (...args) => {
      target.styles.set(property, args);
      return receiver;
    };
  },
});

const createBuilder = (kind) => (...args) => node(kind, args.length ? args[0] : null);

const defaultTheme = {
  background: "#111111",
  surface: "#181818",
  canvas: "#202020",
  chrome: "#242424",
  popover: "#282828",
  raised: "#303030",
  hover: "#383838",
  selected: "#404040",
  border: "#4a4a4a",
  input: "#525252",
  foreground: "#f3f3f3",
  muted: "#c0c0c0",
  dim: "#8d8d8d",
  accent: "#5b8def",
  accent_foreground: "#ffffff",
  selection: "#e9e9e9",
  working: "#3fae6a",
  blocked: "#d9649a",
  done: "#e3814f",
  idle: "#8d8d8d",
  inactive: "#8d8d8d",
  unknown: "#8d8d8d",
  ansi0: "#111111",
  ansi1: "#d9649a",
  ansi2: "#3fae6a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi6: "#22a99a",
  ansi7: "#f3f3f3",
  ansi8: "#666666",
  ansi9: "#ef7cae",
  ansi10: "#63d98d",
  ansi11: "#f0b36a",
  ansi12: "#76a9f5",
  ansi13: "#ab9cff",
  ansi14: "#55d4c2",
  ansi15: "#ffffff",
};

function initialCalls() {
  return {
    run: [],
    openOverlay: [],
    exec: [],
    hc: [],
    setAgentOrder: [],
    shared: [],
    notify: [],
    openUrl: [],
    storage: [],
  };
}

/**
 * Installable host doubles for native GPUI mods. The builder is deliberately
 * fluent but records a tree and event handlers instead of talking to GPUI.
 * Host methods that could touch the process, network, or native state reject,
 * so a renderer test cannot accidentally exercise them.
 */
export function createNativeTestHost(initial = {}) {
  const state = {
    spaces: [],
    machines: [],
    panes: [],
    agents: [],
    terminals: [],
    layout: { id: "sidebar", size: { px: 320 } },
    theme: defaultTheme,
    focused: null,
    shared: {},
    home: "/home/dev",
    appHome: "/tmp/herdr-app-test",
    ...initial,
  };
  let calls = initialCalls();
  const storage = new TestStorage(initial.localStorage ?? {}, calls);

  const reset = (next = {}) => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, {
      spaces: [],
      machines: [],
      panes: [],
      agents: [],
      terminals: [],
      layout: { id: "sidebar", size: { px: 320 } },
      theme: defaultTheme,
      focused: null,
      shared: {},
      home: "/home/dev",
      appHome: "/tmp/herdr-app-test",
      ...next,
    });
    calls = initialCalls();
    storage.calls = calls;
    storage.reset(next.localStorage ?? {});
  };

  const failNative = (operation) => (...args) => {
    calls[operation].push(copy(args));
    throw new Error(`${operation} is forbidden in renderer tests`);
  };

  const context = () => ({
    notify() { calls.notify.push({}); },
    stop_propagation() {},
    open_url(url) { calls.openUrl.push(url); },
    spawn: failNative("exec"),
    sleep: failNative("exec"),
    timer: {
      every: failNative("exec"),
      after: failNative("exec"),
    },
  });

  const shared = (key) => copy(state.shared[key]);
  const setShared = (key, value) => {
    state.shared[key] = copy(value);
    calls.shared.push({ key, value: copy(value) });
    return null;
  };

  const herdr = {
    spaces: () => copy(state.spaces),
    machines: () => copy(state.machines),
    panes: () => copy(state.panes),
    agents: () => copy(state.agents),
    terminals: () => copy(state.terminals),
    setAgentOrder: (addresses) => {
      calls.setAgentOrder.push(copy(addresses));
      return null;
    },
    run: (name, args) => {
      calls.run.push({ name, args: copy(args) });
      return null;
    },
    openOverlay: (spec) => {
      calls.openOverlay.push(copy(spec));
      return `test-overlay-${calls.openOverlay.length}`;
    },
    exec: failNative("exec"),
    hc: failNative("hc"),
    home: () => state.home,
    appHome: () => state.appHome,
    readTextFile: failNative("exec"),
    theme: () => copy(state.theme),
    shared,
    setShared,
    watchFolder: failNative("exec"),
    window: () => ({ active: false, platform: "linux", titlebar: "system", buttons: true, maximized: false, fullscreen: false }),
    layout: () => copy(state.layout),
    notify: (value) => {
      calls.notify.push(copy(value));
      return `test-notification-${calls.notify.length}`;
    },
    focused: () => copy(state.focused),
    nextCommand: failNative("exec"),
  };

  const host = {
    state,
    storage,
    context,
    herdr,
    gpuiKit: {
      View: class View {
        constructor(props) {
          this.props = props;
        }
      },
      div: createBuilder("div"),
      image: createBuilder("image"),
      svg: createBuilder("svg"),
    },
    gpuiBase: {
      h_flex: createBuilder("h_flex"),
      v_flex: createBuilder("v_flex"),
    },
    reset,
  };
  Object.defineProperty(host, "calls", { enumerable: true, get: () => calls });
  return host;
}

export function childrenOf(value) {
  return value instanceof NativeNode || value?._children ? value._children : [];
}

export function walkTree(value) {
  if (Array.isArray(value)) return value.flatMap(walkTree);
  if (!value || typeof value !== "object") return [];
  return [value, ...childrenOf(value).flatMap(walkTree)];
}

export function findNode(root, id) {
  return walkTree(root).find((value) => value.nodeId === id) ?? null;
}

export function findNodes(root, predicate) {
  return walkTree(root).filter(predicate);
}

export function trigger(root, id, event, payload = {}, cx = null) {
  const target = typeof id === "string" ? findNode(root, id) : id;
  if (!target) throw new Error(`No rendered node with id ${id}`);
  const handler = target._handlers.get(event);
  if (!handler) throw new Error(`No ${event} handler on rendered node ${id}`);
  return handler(payload, cx);
}

export function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return childrenOf(value).map(textOf).join("");
}

export function snapshotTree(value) {
  if (Array.isArray(value)) return value.map(snapshotTree);
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return {
    kind: value.kind,
    id: value.nodeId,
    value: copy(value.value),
    text: textOf(value),
    children: childrenOf(value).map(snapshotTree),
    handlers: [...value._handlers.keys()],
  };
}
