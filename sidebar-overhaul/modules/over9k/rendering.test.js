import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import {
  emptyVisibilityState,
  normalizeVisibilityState,
  VISIBILITY_ACTIONS,
  VISIBILITY_STATE,
} from "./agent-visibility.js";
import { startPresentationSession } from "./agent-presentation.js";
import {
  createNativeTestHost,
  childrenOf,
  findNode,
  textOf,
  trigger,
} from "./native-test-host.js";

const host = createNativeTestHost();
let sshScanOutput = null;
let recoveryReads = 0;
globalThis.localStorage = host.storage;
globalThis.sessionStorage = host.storage;
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => host.gpuiBase);
mock.module("herdr", () => ({ ...host.herdr, writeTextFile: async () => {},
  shared: key => {
    if (key === "over9k.recovery") recoveryReads += 1;
    return host.herdr.shared(key);
  },
  exec: (...args) => sshScanOutput === null ? host.herdr.exec(...args) : Promise.resolve({ code: 0, stdout: sshScanOutput }) }));
const { default: Spaces } = await import("./main.js");
const { publishSidebarConfig, clearSidebarConfigCache } = await import("../../config-store.js");

const agentProgram = {
  key: "claude",
  name: "Claude Code",
  icon: null,
  tint: false,
  tile: null,
  color: null,
  shell: false,
  agent: true,
};
const codexProgram = { ...agentProgram, key: "codex", name: "Codex" };
const shellProgram = {
  key: "shell",
  name: "zsh",
  icon: null,
  tint: false,
  tile: null,
  color: null,
  shell: true,
  agent: false,
};

const recoverySessionPath = "/tmp/omp/t-alpha-session.jsonl";
export const recoveryRecord = {
  key: JSON.stringify([null, "session", recoverySessionPath]),
  machine: null,
  address: "t-alpha",
  created_ms: 30,
  title: "Recovered Alpha",
  app: "omp",
  cwd: "/workspaces/Alpha",
  owner: { id: "local-alpha", name: "Alpha", folder: "/workspaces/Alpha" },
  visual: { key: "local-alpha", label: "Alpha", folder: "/workspaces/Alpha", machine: null, kind: "space" },
  sessionId: "t-alpha-session",
  sessionPath: recoverySessionPath,
  verified: true,
  lastSeen: null,
};
export const workingSets = { version: 1, active: null, sets: {} };

function tab(id, name, active = true) {
  return {
    id,
    index: 1,
    name,
    named: !/^(\d+|t[0-9a-z]+)$/.test(name),
    active,
    status: null,
    panes: 1,
    zoomed: false,
    settled: false,
    settled_at: null,
    changed_at: null,
    working_since: null,
  };
}

function space(id, name, folder, machine, tabInfo, active = false) {
  return {
    id,
    index: 0,
    name,
    named: name !== "~",
    folder,
    machine,
    branch: null,
    active,
    status: null,
    tabs: [tabInfo],
  };
}

function pane({ pane: id, terminal, tab: tabId, cwd, program, title, status, focused = false }) {
  return {
    pane: id,
    terminal,
    tab: tabId,
    title,
    cwd,
    branch: null,
    status,
    app: program.agent ? program.key : null,
    program,
    focused,
    zoomed: false,
    movable: true,
  };
}

function reviveTerminal({ address, cwd, parent = null, program, title, status, name, created }) {
  const reviveAgent = program.agent ? (program.key === "codex" ? "codex" : "omp") : null;
  const labels = reviveAgent
    ? {
        "revive.agent": reviveAgent,
        "revive.session": `${address}-session`,
        "revive.transcript": `/tmp/omp/${address}-session.jsonl`,
        "revive.cwd": cwd,
      }
    : {};
  return {
    address,
    parent,
    state: "live",
    status,
    report: { status, seq: created },
    program,
    agent: program.agent ? program.key : "zsh",
    name,
    cwd,
    title,
    created_ms: created,
    foreground: { pid: created, cwd, name: reviveAgent ?? "zsh" },
    labels,
  };
}

function agent({ address, pane: paneId, space: spaceId, tab: tabId, title, status, seq }) {
  return {
    address,
    pane: paneId,
    space: spaceId,
    space_name: spaceId,
    tab: tabId,
    tab_index: 1,
    tab_name: title,
    status,
    app: "claude-code",
    program: agentProgram,
    title,
    seq,
    pinned: false,
    focused: false,
  };
}

function git(folder, linked = false) {
  return {
    name: "Alpha",
    branch: linked ? "feature" : "main",
    ahead: 0,
    behind: 0,
    dirty: 0,
    web: null,
    slug: null,
    top: linked ? `${folder}/..` : folder,
    repo: JSON.stringify([null, "/workspaces/Alpha/.git"]),
    linked,
  };
}

function fixture({ viewMode = null, localStorage = {}, visibility = null, subsOpen = ["t-alpha"], reload = null, hiddenRemovals = [], hiddenListings = null, localReady = false } = {}) {
  const localHomeTab = tab("tb-local-home", "1");
  const alphaTab = tab("tb-alpha", "Alpha task");
  const worktreeTab = tab("tb-feature", "Feature task");
  const remoteHomeTab = tab("tb-remote-home", "1");
  const spaces = [
    space("local-home", "~", "/home/dev", null, localHomeTab, true),
    space("local-alpha", "Alpha", "/workspaces/Alpha", null, alphaTab),
    space("local-feature", "Feature", "/workspaces/Alpha/.worktree/feature", null, worktreeTab),
    space("unraid-dev/sp-home", "Home", "/home/dev", "unraid-dev", remoteHomeTab),
  ];
  const panes = [
    pane({ pane: "p-home", terminal: "t-home", tab: localHomeTab.id, cwd: "/home/dev", program: shellProgram, title: "zsh", status: "idle", focused: true }),
    pane({ pane: "p-alpha", terminal: "t-alpha", tab: alphaTab.id, cwd: "/workspaces/Alpha", program: agentProgram, title: "Claude Code - Alpha task - Alpha", status: "working" }),
    pane({ pane: "p-feature", terminal: "t-feature", tab: worktreeTab.id, cwd: "/workspaces/Alpha/.worktree/feature", program: agentProgram, title: "Claude Code - Feature task - feature", status: "done" }),
    pane({ pane: "p-remote", terminal: "unraid-dev/t-remote", tab: remoteHomeTab.id, cwd: "/workspaces/MusicBumble", program: agentProgram, title: "Claude Code - MusicBumble task - MusicBumble", status: "working" }),
  ];
  const agents = [
    agent({ address: "t-alpha", pane: "p-alpha", space: "local-alpha", tab: alphaTab.id, title: "Claude Code - Alpha task - Alpha", status: "working", seq: 30 }),
    agent({ address: "t-feature", pane: "p-feature", space: "local-feature", tab: worktreeTab.id, title: "Claude Code - Feature task - feature", status: "done", seq: 20 }),
    agent({ address: "unraid-dev/t-remote", pane: "p-remote", space: "unraid-dev/sp-home", tab: remoteHomeTab.id, title: "Claude Code - MusicBumble task - MusicBumble", status: "working", seq: 40 }),
  ];
  const terminals = [
    reviveTerminal({ address: "t-home", cwd: "/home/dev", program: shellProgram, title: "zsh", status: "idle", name: "shell", created: 1 }),
    reviveTerminal({ address: "t-alpha", cwd: "/workspaces/Alpha", program: agentProgram, title: "Claude Code - Alpha task - Alpha", status: "working", name: "Alpha task", created: 30 }),
    reviveTerminal({ address: "t-alpha-child", cwd: "/workspaces/Alpha", parent: "t-alpha", program: codexProgram, title: "Codex - child", status: "working", name: "Alpha child", created: 31 }),
    reviveTerminal({ address: "t-feature", cwd: "/workspaces/Alpha/.worktree/feature", program: agentProgram, title: "Claude Code - Feature task - feature", status: "done", name: "Feature task", created: 20 }),
    reviveTerminal({ address: "unraid-dev/t-remote", cwd: "/workspaces/MusicBumble", program: agentProgram, title: "Claude Code - MusicBumble task - MusicBumble", status: "working", name: "MusicBumble task", created: 40 }),
  ];
  const remote = {
    "unraid-dev": {
      home: "/home/dev",
      chats: "~",
      projects: "~",
      dirs: [],
      asked: {},
    },
  };
  const visibilityState = normalizeVisibilityState(visibility ?? emptyVisibilityState());
  return {
    spaces,
    panes,
    agents,
    terminals,
    machines: [...(localReady ? [{ name: null, layout: "ready" }] : []), { name: "unraid-dev", state: "connected", layout: "ready" }],
    remote,
    viewMode,
    localStorage,
    subsOpen,
    git: {
      [JSON.stringify([null, "/workspaces/Alpha"])]: git("/workspaces/Alpha"),
      [JSON.stringify([null, "/workspaces/Alpha/.worktree/feature"])]: git("/workspaces/Alpha/.worktree/feature", true),
    },
    shared: {
      "space.colors": {},
      "projects.pinned": ["/workspaces/Alpha"],
      "projects.hidden": [],
      "projects.unpinned": [],
      "projects.on": { "unraid-dev": { pinned: [], hidden: [], unpinned: [], names: {} } },
      "projects.names": {},
      "projects.autoOn": {},
      "projects.listed": [],
      "sidebar.options": { layout: "expanded", keepUpToDate: false },
      "over9k.setupDone": true,
      "over9k.recovery": { version: 1, records: { [recoveryRecord.key]: recoveryRecord } },
      "over9k.hiddenRemovals": hiddenRemovals,
      "over9k.hiddenListings": hiddenListings ?? { version: 1, records: {}, groups: {} },
      "over9k.workingSets": workingSets,
      ...(reload ? { "over9k.reload": reload } : {}),
      [VISIBILITY_STATE]: visibilityState,
      [VISIBILITY_ACTIONS]: [],
    },
    layout: { id: "sidebar", size: { px: 320 } },
  };
}

function makeSidebar(options = {}) {
  const data = fixture(options);
  host.reset(data);
  if (options.visibility) reportStatus(["t-alpha", "t-alpha-child", "unraid-dev/t-remote"], "idle");
  const view = new Spaces();
  view.visibility = normalizeVisibilityState(data.shared[VISIBILITY_STATE]);
  view.recovery = data.shared["over9k.recovery"];
  view.recoveryCapture = [];
  view.workingSets = data.shared["over9k.workingSets"];
  view.reloadRequestId = data.shared["over9k.reload"]?.status === "pending" ? data.shared["over9k.reload"].requestId : null;
  view.presentation = startPresentationSession();
  view.git = data.git;
  view.shared = "";
  view.checked = {};
  view.unsure = new Set();
  view.pending = new Set();
  view.busy = {};
  view.ready = {};
  view.at = {};
  view.watching = new Set();
  view.shown = new Set(data.spaces.map((item) => item.id));
  view.born = {};
  view.pressed = null;
  view.over = null;
  view.machines = data.machines;
  view.folded = new Set();
  view.recent = [];
  view.projects = [];
  view.auto = [];
  view.tops = new Map();
  view.lastCmd = {};
  view.agentsFolded = new Set();
  view.closedOpen = false;
  view.closedOpenOn = {};
  view.remote = data.remote;
  view.info = {};
  view.infoDir = "/tmp/omp/agents";
  view.piInfo = {};
  view.models = {};
  view.serverEffort = {};
  view.serversUp = {};
  view.hoverServer = null;
  view.lastWork = {};
  view.wasWorking = {};
  view.subsOpen = new Set(data.subsOpen);
  if (data.viewMode === "space" || data.viewMode === "status") view.restoreView(data.viewMode);
  else view.loadView();
  view.closedAt = null;
  view.prs = {};
  view.write = {};
  view.repoInfo = {};
  view.me = null;
  view.armed = null;
  view.sel = new Set();
  view.subs = {};
  view.tasks = {};
  view.sshTo = {};
  view.subSsh = {};
  view.sshSeen = 0;
  view.viewers = {};
  view.linkColors = {};
  view.hoverLink = null;
  view.hoverTerm = null;
  view.hoverSpace = null;
  view.tagWhere = null;
  view.onlyPane = null;
  return view;
}

function reportStatus(addresses, status) {
  host.state.agents = host.state.agents.map(agent => addresses.includes(agent.address) ? { ...agent, status } : agent);
  host.state.terminals = host.state.terminals.map(term => addresses.includes(term.address) ? { ...term, status, report: { ...term.report, status } } : term);
}

function renderSidebar(view) {
  return view.render(host.context());
}

test("failed worktree setup opens its terminal and does not mark a different space", () => {
  const view = makeSidebar({ viewMode: "space" });
  const setup = host.state.terminals.find(term => term.address === "t-feature");
  setup.labels = { "over9k.worktree.status": "failed", "over9k.worktree.cwd": setup.cwd };
  const root = renderSidebar(view);
  assert.equal(textOf(findNode(root, "worktree-setup-local-feature")), "Setup failed");
  assert.equal(findNode(root, "worktree-setup-local-alpha"), null);
  trigger(root, "worktree-setup-local-feature", "click", {}, host.context());
  assert.deepEqual(host.calls.run, [{ name: "space.select", args: { id: "local-feature" } }, { name: "pane.focus", args: { pane: "p-feature" } }]);
});

function renderDiagnostics() {
  const current = JSON.parse(host.storage.getItem("over9k.renderDiagnostics"));
  const history = JSON.parse(host.storage.getItem("over9k.renderDiagnostics.history"));
  return { ...current, failures: history?.failures ?? [] };
}

function assertNoForbiddenHostCalls(expectedRun = []) {
  assert.deepEqual(host.calls.exec, [], "rendering must not spawn process work");
  assert.deepEqual(host.calls.hc, [], "rendering must not call herdr-core");
  assert.deepEqual(host.calls.run, expectedRun, "only explicitly exercised native callbacks may run");
  assert.deepEqual(host.calls.openOverlay, [], "rendering must not open overlays");
}


test("pinned agents do not add quick-launch controls to sidebar rows", () => {
  const view = makeSidebar({ viewMode: "space" });
  host.state.shared["over9k.startPin"] = {
    "": { key: "omp", name: "omp", run: ["omp"] },
    "unraid-dev": { key: "omp", name: "omp", run: ["omp"] },
  };
  view.hoverSpace = "local-alpha";
  const root = renderSidebar(view);
  assert.equal(findNode(root, "start-"), null);
  assert.equal(findNode(root, "start-unraid-dev"), null);
  assert.ok(findNode(root, "add-local-alpha"), "the normal space + menu remains available");
  assertNoForbiddenHostCalls();
});

test("double-clicking a parked project starts OMP on its own machine", () => {
  const view = makeSidebar({ viewMode: "space" });
  const folder = "/workspaces/Parked";
  view.frame = { options: {} };
  view.vis = [];
  for (const machine of [null, "unraid-dev"]) {
    const row = view.closedRow(folder, host.herdr.theme(), false, machine);
    trigger(row, "project-Parked", "click", { click_count: 2, modifiers: {} }, host.context());
  }
  assert.deepEqual(host.calls.run, ["", "unraid-dev"].map(machine => ({
    name: "space.new", args: { name: "Parked", folder, machine, argv: ["bash", "-lc", "exec omp"] },
  })));
});

test("space + preserves Scripts target while active pane is elsewhere", () => {
  const view = makeSidebar({ viewMode: "space" });
  host.state.spaces = host.state.spaces.map(space => space.id === "local-alpha"
    ? { ...space, name: "Scripts", folder: "/home/jason/Scripts" } : space);
  view.hoverSpace = "local-alpha";
  const root = renderSidebar(view);
  trigger(root, "add-local-alpha", "click", {}, host.context());
  assert.deepEqual(host.calls.run, [{ name: "space.select", args: { id: "local-alpha" } }]);
  assert.deepEqual(host.calls.openOverlay, [{ mod: "sidebar-overhaul", kind: "popup", width: 340, height: 640,
    props: { space: "local-alpha", folder: "/home/jason/Scripts", machine: null, view: "new-menu" } }]);
});

for (const machine of [null, "unraid-dev"]) test(`machine heading opens its action menu for ${machine ?? "local"}`, () => {
  const view = makeSidebar({ viewMode: "space" });
  const root = renderSidebar(view);
  trigger(root, `machine-${machine ?? "local"}`, "mouse_down:right", {}, host.context());
  assert.deepEqual(host.calls.openOverlay, [{ mod: "sidebar-overhaul", kind: "popup", width: 260, height: 90,
    props: { tab: "machine", target: { machine }, view: "menu" } }]);
  assert.deepEqual(host.calls.run, []);
});

test("sidebar context rows open the internal menu with the right target", () => {
  let root = renderSidebar(makeSidebar({ viewMode: "space" }));
  trigger(root, "space-local-alpha", "mouse_down:right", {}, host.context());
  assert.deepEqual(host.calls.openOverlay, [{
    mod: "sidebar-overhaul", kind: "popup", width: 230, height: 325,
    props: { tab: "space", target: { id: "local-alpha", group: { key: "local-alpha", kind: "space", label: "Alpha", machine: null, folder: "/workspaces/Alpha" } }, view: "menu" },
  }]);


  root = renderSidebar(makeSidebar({ viewMode: "space" }));
  trigger(root, "loose-unraid-dev-MusicBumble", "mouse_down:right", {}, host.context());
  assert.deepEqual(host.calls.openOverlay, [{
    mod: "sidebar-overhaul", kind: "popup", width: 220, height: 225,
    props: { tab: "project", target: { folder: "/workspaces/MusicBumble", name: "MusicBumble", machine: "unraid-dev", group: { key: "r:unraid-dev:/workspaces/MusicBumble", kind: "project", label: "MusicBumble", machine: "unraid-dev", folder: "/workspaces/MusicBumble" } }, view: "menu" },
  }]);
  const selected = makeSidebar({ viewMode: "space" });
  selected.sel = new Set(["p:p-remote", "p:p-alpha"]);
  root = renderSidebar(selected);
  trigger(root, "term-unraid-dev/t-remote", "mouse_down:right", {}, host.context());
  assert.deepEqual(host.calls.openOverlay, [{
    mod: "sidebar-overhaul", kind: "popup", width: 240, height: 120,
    props: { tab: "selection", target: { spaces: [], panes: ["p-remote", "p-alpha"], folders: [] }, view: "menu" },
  }]);
  assert.deepEqual(host.calls.run, []);
});

test("Space renders real space and agent rows, keeps worktree families contiguous, and orders native agents without host side effects", () => {
  const view = makeSidebar({ viewMode: "space" });
  const root = renderSidebar(view);
  const scroll = findNode(root, "spaces-scroll");

  assert.ok(scroll, "Space view should render the scroll surface");
  assert.equal(textOf(findNode(root, "view-toggle")), "Space");
  assert.equal(findNode(root, "filter-all"), null, "obsolete All control should be absent");
  assert.equal(findNode(root, "filter-agents"), null, "obsolete Agents control should be absent");
  assert.ok(findNode(root, "machine-local"), "local machine heading should be rendered");
  assert.ok(findNode(root, "machine-unraid-dev"), "remote machine heading should be rendered");
  assert.match(textOf(scroll), /Alpha task/);
  assert.match(textOf(scroll), /MusicBumble task/);
  const remoteGroup = findNode(root, "loose-unraid-dev-MusicBumble");
  const remoteTerm = findNode(root, "term-unraid-dev/t-remote");
  const remoteMachine = findNode(root, "machine-unraid-dev");
  const scrollChildren = childrenOf(scroll);
  const remoteMachineIndex = scrollChildren.indexOf(remoteMachine);
  const remoteGroupIndex = scrollChildren.indexOf(remoteGroup);
  assert.ok(remoteMachineIndex >= 0 && remoteMachineIndex < remoteGroupIndex,
    "remote visual project must remain in the remote machine block");
  assert.ok(remoteGroup, "remote visual project row should be rendered");
  assert.ok(remoteTerm, "remote agent row should be rendered");
  assert.equal(scrollChildren.indexOf(remoteTerm), scrollChildren.indexOf(remoteGroup) + 1,
    "remote visual project header and its terminal must stay adjacent in the machine block");
  const projection = host.state.shared["over9k.visualGroups"];
  assert.equal(projection?.version, 1, "the frame should publish its visual-group projection");
  const shellGroup = projection.groups.find((group) => group.key === "local-home");
  const musicProjection = projection.groups.find((group) => group.key === "r:unraid-dev:/workspaces/MusicBumble");
  assert.ok(shellGroup?.members.some((member) => member.address === "t-home" && member.created_ms === 1),
    "the native shell must remain in its own visual group");
  assert.deepEqual(musicProjection?.members, [{ address: "unraid-dev/t-remote", created_ms: 40 }],
    "a remote visual project must not absorb its native Home shell");
  const drawn = view.drawn.map((row) => row.w.id);
  const alpha = drawn.indexOf("local-alpha");
  const feature = drawn.indexOf("local-feature");
  const nativeOrder = host.calls.setAgentOrder.at(-1);
  assert.deepEqual(nativeOrder, ["t-alpha", "t-feature", "unraid-dev/t-remote", "t-alpha-child"],
    "native agent order should include agents only and exclude the shell terminal");
  assertNoForbiddenHostCalls();
});
test("identical advancing-clock frames settle to zero shared writes", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {}, "t-feature": {} };
  visibility.groups = {
    "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null },
  };
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const view = makeSidebar({ visibility });
    const root = renderSidebar(view);
    assert.equal(textOf(findNode(root, "view-toggle")), "Space", "the normal Space mode should remain active");
    assert.ok(findNode(root, "hidden-agents"), "the hidden drawer should remain available");
    assert.ok(findNode(root, "hidden-group-section-local-alpha"), "the hidden group should remain listed");
    assert.ok(findNode(root, "hidden-agent-t-alpha"), "the first hidden agent should remain listed");
    assert.ok(findNode(root, "hidden-agent-t-feature"), "the second hidden agent should remain listed");
    assert.equal(findNode(root, "term-t-alpha"), null);
    assert.equal(findNode(root, "term-t-feature"), null);
    assert.ok(findNode(root, "term-unraid-dev/t-remote"), "the unrelated live agent must remain visible");

    const writes = [];
    for (let frame = 0; frame < 4; frame++) {
      now += 60_000;
      host.calls.shared.length = 0;
      renderSidebar(view);
      writes.push(host.calls.shared.length);
    }
    const settled = writes.findIndex((count) => count === 0);
    assert.ok(settled >= 0, `repeated frames should reach zero shared writes: ${writes.join(",")}`);
    assert.deepEqual(
      writes.slice(settled),
      writes.slice(settled).map(() => 0),
      "shared writes must remain at zero after the frame settles",
    );
  } finally {
    Date.now = originalNow;
  }
});

test("plain agent rows use native hover while linked rows only redraw on hover changes", () => {
  const view = makeSidebar({ viewMode: "status" });
  const root = renderSidebar(view);
  const plain = findNode(root, "term-t-feature");
  assert.ok(plain.styles.has("hover"));
  assert.equal(plain._handlers.has("hover"), false);
  const cx = host.context();
  for (const hovered of [true, true, false, false]) trigger(root, "term-t-alpha", "hover", hovered, cx);
  assert.equal(host.calls.notify.length, 2, "only actual linked hover changes should redraw");
  assert.ok(findNode(root, "agent-menu-t-feature"));
});

test("agent hover leaves the recovery archive alone and persistence preserves history and changed metadata", () => {
  const view = makeSidebar({ viewMode: "status" });
  let root = renderSidebar(view);
  view.persistRecovery();
  const archive = host.state.shared["over9k.recovery"];
  const key = recoveryRecord.key;
  const historicalKey = JSON.stringify([null, "session", "/tmp/older.jsonl"]);
  const historical = { ...archive.records[key], key: historicalKey, address: "t-older", sessionId: "older", sessionPath: "/tmp/older.jsonl" };
  // Another recovery writer can add records while the sidebar is open.
  archive.records[historicalKey] = historical;
  const reads = recoveryReads;
  for (const hovered of [true, false, true, false]) {
    trigger(root, "term-t-alpha", "hover", hovered, host.context());
    root = renderSidebar(view);
    view.persistRecovery();
  }
  assert.equal(recoveryReads, reads, "hover and the following background flush must not read the archive");

  host.state.agents[0].title = "Updated recovery title";
  renderSidebar(view);
  assert.equal(recoveryReads, reads, "even a new capture must not read the archive in render");
  assert.notEqual(archive.records[key].title, "Updated recovery title");
  view.persistRecovery();
  const saved = host.state.shared["over9k.recovery"].records;
  assert.equal(saved[key].title, "Updated recovery title");
  assert.deepEqual(saved[historicalKey], historical);
});


test("Status hides a space whose only agents are hidden while Space keeps the space row", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {}, "t-feature": {} };

  const spaceRoot = renderSidebar(makeSidebar({ viewMode: "space", visibility }));
  assert.equal(findNode(spaceRoot, "space-local-alpha"), null, "Space hides an all-hidden space");
  assert.equal(findNode(spaceRoot, "term-t-alpha"), null);
  assert.equal(findNode(spaceRoot, "term-t-feature"), null);

  const statusRoot = renderSidebar(makeSidebar({ viewMode: "status", visibility }));
  assert.equal(findNode(statusRoot, "term-t-alpha"), null);
  assert.equal(findNode(statusRoot, "term-t-feature"), null);
  assert.ok(findNode(statusRoot, "term-unraid-dev/t-remote"), "a visible remote agent remains");
  assertNoForbiddenHostCalls();
});

test("Space keeps the full list while Status groups agents by state and preserves labels", () => {
  const bySpace = makeSidebar({ viewMode: "space" });
  const spaceRoot = renderSidebar(bySpace);
  assert.equal(textOf(findNode(spaceRoot, "view-toggle")), "Space");
  assert.equal(findNode(spaceRoot, "section-working"), null, "Space mode must not produce status sections");
  assert.ok(findNode(spaceRoot, "term-t-home"), "Space mode must retain the native shell row");
  const spaceRemoteGroup = findNode(spaceRoot, "loose-unraid-dev-MusicBumble");
  const spaceRemoteTerm = findNode(spaceRoot, "term-unraid-dev/t-remote");
  const spaceRemoteMachine = findNode(spaceRoot, "machine-unraid-dev");
  const spaceScrollChildren = childrenOf(findNode(spaceRoot, "spaces-scroll"));
  const spaceRemoteMachineIndex = spaceScrollChildren.indexOf(spaceRemoteMachine);
  const spaceRemoteGroupIndex = spaceScrollChildren.indexOf(spaceRemoteGroup);
  assert.ok(spaceRemoteMachineIndex >= 0 && spaceRemoteMachineIndex < spaceRemoteGroupIndex,
    "Space must keep the remote project under its machine heading");
  assert.ok(spaceRemoteGroup);
  assert.ok(spaceRemoteTerm);
  assert.equal(spaceScrollChildren.indexOf(spaceRemoteTerm), spaceScrollChildren.indexOf(spaceRemoteGroup) + 1,
    "Space must keep the remote visual header immediately before its row");
  assert.match(textOf(spaceRemoteGroup), /MusicBumble/);

  const byStatus = makeSidebar({ viewMode: "status" });
  const statusRoot = renderSidebar(byStatus);
  assert.equal(textOf(findNode(statusRoot, "view-toggle")), "Status");
  assert.ok(findNode(statusRoot, "section-working"));
  assert.ok(findNode(statusRoot, "section-done"));
  assert.equal(findNode(statusRoot, "machine-local"), null, "Status mode should use state sections rather than machine headings");
  assert.equal(findNode(statusRoot, "term-t-home"), null, "Status mode must omit shell rows");
  assert.match(textOf(findNode(statusRoot, "section-working")), /Working3/);
  assert.match(textOf(findNode(statusRoot, "section-done")), /Done1/);
  const remoteRow = findNode(statusRoot, "term-unraid-dev/t-remote");
  assert.match(textOf(remoteRow), /\/workspaces\/MusicBumble/);
  assert.match(textOf(remoteRow), /unraid-dev/);
  const statusScroll = findNode(statusRoot, "spaces-scroll");
  const statusChildren = childrenOf(statusScroll);
  const parent = findNode(statusRoot, "term-t-alpha");
  const child = findNode(statusRoot, "agent-t-alpha-child");
  assert.ok(parent, "the working agent row should render");
  assert.ok(child, "the child agent renders independently");
  assert.equal(findNode(statusRoot, "kid-t-alpha-child"), null);
  assert.match(textOf(child), /Alpha child|Codex/);
  trigger(statusRoot, "agent-t-alpha-child", "click", { click_count: 1, modifiers: {} }, host.context());
  assertNoForbiddenHostCalls([{ name: "terminal.peek", args: { terminal: "t-alpha-child" } }]);
});

test("view toggle switches both directions, persists the mode, and has no native side effects", () => {
  const view = makeSidebar({ viewMode: "space" });
  let root = renderSidebar(view);
  let toggle = findNode(root, "view-toggle");
  assert.equal(textOf(toggle), "Space");
  assert.deepEqual(toggle.styles.get("tooltip"), ["Switch to Status view"]);

  trigger(root, toggle, "click", {}, host.context());
  assert.equal(view.viewMode, "status");
  assert.equal(host.storage.getItem("sidebar.view"), "status");
  assert.equal(host.calls.run.length, 0);
  assert.deepEqual(host.calls.openOverlay, []);
  root = renderSidebar(view);
  toggle = findNode(root, "view-toggle");
  assert.equal(textOf(toggle), "Status");
  assert.deepEqual(toggle.styles.get("tooltip"), ["Switch to Space view"]);
  assert.equal(findNode(root, "term-t-home"), null);

  trigger(root, toggle, "click", {}, host.context());
  assert.equal(view.viewMode, "space");
  assert.equal(host.storage.getItem("sidebar.view"), "space");
  root = renderSidebar(view);
  assert.equal(textOf(findNode(root, "view-toggle")), "Space");
  assert.ok(findNode(root, "term-t-home"));
  assert.equal(host.calls.run.length, 0);
  assert.deepEqual(host.calls.openOverlay, []);
  assertNoForbiddenHostCalls();
});

test("saved view restores and legacy selections migrate to sidebar.view", () => {
  const cases = [
    {
      storage: { "sidebar.view": "status", "agents.filter": "", "agents.by": "space" },
      mode: "status",
    },
    {
      storage: { "agents.filter": "", "agents.by": "state" },
      mode: "space",
    },
    {
      storage: { "agents.filter": "agents", "agents.by": "space" },
      mode: "space",
    },
    {
      storage: { "agents.filter": "agents", "agents.by": "state" },
      mode: "status",
    },
  ];
  for (const { storage, mode } of cases) {
    const view = makeSidebar({ localStorage: storage });
    assert.equal(view.viewMode, mode);
    assert.equal(host.storage.getItem("sidebar.view"), mode);
    assert.equal(host.storage.getItem("agents.filter"), null);
    assert.equal(host.storage.getItem("agents.by"), null);
    const root = renderSidebar(view);
    assert.equal(textOf(findNode(root, "view-toggle")), mode === "status" ? "Status" : "Space");
  }
  assertNoForbiddenHostCalls();
});

test("Space folds a native space together with its worktree family", () => {
  const view = makeSidebar({ viewMode: "space" });
  host.state.spaces = host.state.spaces.map((item) => ({ ...item, active: item.id === "local-alpha" }));
  let root = renderSidebar(view);

  assert.ok(findNode(root, "space-local-alpha"));
  assert.ok(findNode(root, "space-local-feature"), "the worktree should initially follow its parent");
  assert.ok(findNode(root, "term-t-alpha"));
  assert.ok(findNode(root, "term-t-feature"));
  assert.ok(findNode(root, "term-unraid-dev/t-remote"));

  const parent = findNode(root, "space-local-alpha");
  trigger(root, parent, "mouse_down:left", { click_count: 1, modifiers: {} }, host.context());
  trigger(root, parent, "mouse_up:left", { click_count: 1, modifiers: {} }, host.context());
  assert.equal(view.agentsFolded.has("local-alpha"), true, "the production row mouse contract should fold the active space");

  root = renderSidebar(view);
  assert.ok(findNode(root, "space-local-alpha"), "the folded parent header must remain");
  assert.ok(findNode(root, "space-local-feature"), "live worktree header remains visible");
  assert.ok(findNode(root, "term-t-alpha"), "folding cannot remove the live parent agent");
  assert.ok(findNode(root, "term-t-feature"), "folding cannot remove the live worktree agent");
  assert.ok(findNode(root, "term-unraid-dev/t-remote"), "folding a local family must not hide the remote family");
  assertNoForbiddenHostCalls();
});

test("Space keeps loose remote project folds independent", () => {
  const view = makeSidebar({ viewMode: "space" });
  const otherAddress = "unraid-dev/t-other";
  const otherTitle = "Claude Code - Other task - OtherRemote";
  host.state.panes.push(pane({
    pane: "p-other",
    terminal: otherAddress,
    tab: "tb-remote-home",
    cwd: "/workspaces/OtherRemote",
    program: agentProgram,
    title: otherTitle,
    status: "working",
  }));
  host.state.agents.push(agent({
    address: otherAddress,
    pane: "p-other",
    space: "unraid-dev/sp-home",
    tab: "tb-remote-home",
    title: otherTitle,
    status: "working",
    seq: 50,
  }));
  host.state.terminals.push(reviveTerminal({
    address: otherAddress,
    cwd: "/workspaces/OtherRemote",
    program: agentProgram,
    title: otherTitle,
    status: "working",
    name: "Other task",
    created: 50,
  }));

  let root = renderSidebar(view);
  const music = findNode(root, "loose-unraid-dev-MusicBumble");
  const other = findNode(root, "loose-unraid-dev-OtherRemote");
  assert.ok(music);
  assert.ok(other);
  assert.ok(findNode(root, "term-unraid-dev/t-remote"));
  assert.ok(findNode(root, `term-${otherAddress}`));

  trigger(root, music, "click", {}, host.context());
  assert.equal(view.agentsFolded.has("r:unraid-dev:/workspaces/MusicBumble"), true);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-unraid-dev/t-remote"), "folding cannot remove the live remote agent");
  assert.ok(findNode(root, `term-${otherAddress}`), "the other remote project must stay expanded");

  trigger(root, "loose-unraid-dev-OtherRemote", "click", {}, host.context());
  root = renderSidebar(view);
  assert.ok(findNode(root, `term-${otherAddress}`), "live remote agent survives its project fold");
  assert.ok(findNode(root, "term-unraid-dev/t-remote"));

  trigger(root, "loose-unraid-dev-MusicBumble", "click", {}, host.context());
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-unraid-dev/t-remote"), "expanding one remote project must not expand the other");
  assert.ok(findNode(root, `term-${otherAddress}`), "live agents remain visible independently of project folds");
  assertNoForbiddenHostCalls();
});

test("Status section folding isolates rows, keeps counts, and persists namespaced keys", () => {
  const view = makeSidebar({ viewMode: "status" });
  let root = renderSidebar(view);
  const baselineVisibility = structuredClone(view.visibility);
  const baselineOrder = ["t-alpha", "t-feature", "unraid-dev/t-remote", "t-alpha-child"];
  const working = findNode(root, "section-working");
  const done = findNode(root, "section-done");

  assert.ok(working);
  assert.ok(done);
  assert.match(textOf(working), /Working3/);
  assert.match(textOf(done), /Done1/);
  assert.equal(childrenOf(working)[0].value, "mods/workspace-chrome/chevron-down.svg");
  assert.equal(childrenOf(done)[0].value, "mods/workspace-chrome/chevron-down.svg");

  trigger(root, "section-working", "click", {}, host.context());
  assert.equal(view.agentsFolded.has("status:working"), true);
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), ["status:working"]);
  assert.deepEqual(view.visibility, baselineVisibility);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"), "status folds cannot remove live local agents");
  assert.ok(findNode(root, "term-unraid-dev/t-remote"), "status folds cannot remove live remote agents");
  assert.equal(findNode(root, "kid-t-alpha-child"), null, "folding Working must hide deferred child rows too");
  assert.ok(findNode(root, "term-t-feature"), "folding Working must leave Done rows visible");
  assert.match(textOf(findNode(root, "section-working")), /Working3/, "the folded header keeps its count");
  assert.equal(childrenOf(findNode(root, "section-working"))[0].value, "mods/workspace-chrome/chevron-right.svg");
  assert.match(textOf(findNode(root, "section-done")), /Done1/);

  trigger(root, "section-working", "click", {}, host.context());
  assert.equal(view.agentsFolded.has("status:working"), false);
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), []);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"), "expanding Working must restore its local agent");
  assert.ok(findNode(root, "term-unraid-dev/t-remote"), "expanding Working must restore its remote agent");
  assert.ok(findNode(root, "agent-t-alpha-child"), "live child remains independent");
  assert.ok(findNode(root, "term-t-feature"), "expanding Working must preserve Done rows");

  trigger(root, "section-done", "click", {}, host.context());
  assert.equal(view.agentsFolded.has("status:done"), true);
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), ["status:done"]);
  assert.deepEqual(view.visibility, baselineVisibility);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-feature"), "status folds cannot remove live done agents");
  assert.ok(findNode(root, "term-t-alpha"));
  assert.ok(findNode(root, "term-unraid-dev/t-remote"));
  assert.match(textOf(findNode(root, "section-done")), /Done1/, "the folded Done header keeps its count");
  assert.equal(childrenOf(findNode(root, "section-done"))[0].value, "mods/workspace-chrome/chevron-right.svg");

  trigger(root, "section-done", "click", {}, host.context());
  assert.equal(view.agentsFolded.has("status:done"), false);
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), []);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-feature"));
  assert.deepEqual(view.visibility, baselineVisibility);

  assert.deepEqual(host.calls.setAgentOrder.at(-1), baselineOrder);
  assertNoForbiddenHostCalls();
});


test("hidden project and space groups remain machine-qualified and nest members under the matching parent", () => {
  const remoteKey = "r:unraid-dev:/workspaces/MusicBumble";
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "unraid-dev/t-remote": {} };
  visibility.groups = {
    "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null },
    [remoteKey]: { kind: "project", label: "MusicBumble", folder: "/workspaces/MusicBumble", machine: "unraid-dev" },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  const hidden = findNode(root, "hidden-agents");
  const localMachine = findNode(hidden, "hidden-machine-local");
  const remoteMachine = findNode(hidden, "hidden-machine-unraid-dev");
  const localSection = findNode(localMachine, "hidden-group-section-local-alpha");
  const remoteSection = findNode(remoteMachine, `hidden-group-section-${remoteKey}`);
  const localGroup = findNode(localSection, "hidden-group-local-alpha");
  const remoteGroup = findNode(remoteSection, `hidden-group-${remoteKey}`);

  assert.ok(hidden);
  assert.match(textOf(hidden), /Space: Alpha/);
  assert.match(textOf(hidden), /Project: MusicBumble @ unraid-dev/);
  assert.ok(localMachine, "local hidden groups should be under the local machine section");
  assert.ok(remoteMachine, "remote hidden groups should be under their machine section");
  assert.ok(localSection, "local hidden group should have a dedicated section");
  assert.ok(remoteSection, "remote hidden group should have a dedicated section");
  assert.ok(localGroup);
  assert.ok(remoteGroup);
  assert.ok(findNode(localSection, "hidden-agent-t-alpha"), "local member must be nested under its own section");
  assert.ok(findNode(remoteSection, "hidden-agent-unraid-dev/t-remote"), "remote member must be nested under its own section");
  assert.equal(findNode(localSection, "hidden-agent-unraid-dev/t-remote"), null, "remote member must not cross into a local section");
  assert.equal(findNode(remoteSection, "hidden-agent-t-alpha"), null, "local member must not cross into a remote section");
  assert.ok(host.calls.setAgentOrder.at(-1).includes("unraid-dev/t-remote"), "hidden agents remain in native navigation order");

  trigger(hidden, `restore-hidden-group-${remoteKey}`, "click", {}, host.context());
  assert.equal(view.visibility.groups[remoteKey], undefined);
  assert.ok(view.visibility.groups["local-alpha"], "restoring one machine's group must not restore another");
  root = renderSidebar(view);
  const restoredRemoteSection = findNode(root, `hidden-group-section-${remoteKey}`);
  assert.equal(restoredRemoteSection, null, "whole-group restore includes individually hidden members");
  assert.equal(findNode(root, "hidden-agent-unraid-dev/t-remote"), null);
  assert.ok(findNode(root, "term-unraid-dev/t-remote"), "the restored member returns to its remote group");
  assert.ok(findNode(root, "loose-unraid-dev-MusicBumble"), "restored remote visual project should return to its own machine");

  trigger(root, "restore-hidden-all", "click", {}, host.context());
  assert.deepEqual(view.visibility.hidden, {});
  assert.deepEqual(view.visibility.groups, {});
  assertNoForbiddenHostCalls();
});

test("group-only hiding removes matching live rows while preserving other machine groups", () => {
  const remoteKey = "r:unraid-dev:/workspaces/MusicBumble";
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.groups = {
    [remoteKey]: { kind: "project", label: "MusicBumble", folder: "/workspaces/MusicBumble", machine: "unraid-dev" },
  };
  const root = renderSidebar(makeSidebar({ visibility }));
  const hiddenSection = findNode(root, `hidden-group-section-${remoteKey}`);
  const hiddenGroup = findNode(hiddenSection, `hidden-group-${remoteKey}`);

  assert.ok(hiddenSection);
  assert.ok(hiddenGroup);
  assert.ok(findNode(hiddenSection, "hidden-agent-unraid-dev/t-remote"));
  assert.equal(findNode(root, "term-unraid-dev/t-remote"), null);
  assert.ok(findNode(root, "term-t-alpha"), "local agent must remain visible");
  assert.equal(findNode(hiddenSection, "hidden-agent-t-alpha"), null, "local agent must stay out of remote group");
  assertNoForbiddenHostCalls();
});
test("Hidden category heading folds all machines without changing hidden selections or group folds", () => {
  const remoteKey = "r:unraid-dev:/workspaces/MusicBumble";
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.groups = {
    "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null },
    [remoteKey]: { kind: "project", label: "MusicBumble", folder: "/workspaces/MusicBumble", machine: "unraid-dev" },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  trigger(root, "hidden-group-local-alpha", "click", {}, host.context());
  root = renderSidebar(view);
  const before = structuredClone(view.visibility);
  const heading = textOf(findNode(root, "hidden-section"));
  assert.match(heading, /Hidden5/);
  assert.ok(findNode(root, "hidden-agent-unraid-dev/t-remote"));

  trigger(root, "hidden-section", "click", {}, host.context());
  root = renderSidebar(view);
  assert.ok(findNode(root, "hidden-agents"), "the category heading must remain available to expand");
  assert.equal(textOf(findNode(root, "hidden-section")), heading, "folding must retain the count and actions");
  assert.equal(findNode(root, "hidden-machine-local"), null);
  assert.equal(findNode(root, "hidden-machine-unraid-dev"), null);
  assert.ok(findNode(root, "restore-hidden-all"), "category actions must remain accessible while folded");
  assert.equal(childrenOf(findNode(root, "hidden-section"))[0].value, "mods/workspace-chrome/chevron-right.svg");
  assert.deepEqual(view.visibility, before);
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), ["hidden:local-alpha", "section:hidden"]);

  trigger(root, "hidden-section", "click", {}, host.context());
  root = renderSidebar(view);
  assert.ok(findNode(root, "hidden-machine-local"));
  assert.ok(findNode(root, "hidden-machine-unraid-dev"));
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null, "expanding the category must preserve an individual group fold");
  assert.ok(findNode(root, "hidden-agent-unraid-dev/t-remote"));
  assert.equal(childrenOf(findNode(root, "hidden-section"))[0].value, "mods/workspace-chrome/chevron-down.svg");
  assert.deepEqual(view.visibility, before);
  assert.deepEqual(host.calls.setAgentOrder.at(-1), ["t-alpha", "t-feature", "unraid-dev/t-remote", "t-alpha-child"]);

  trigger(root, "hidden-section", "click", {}, host.context());
  root = renderSidebar(view);
  const actionCx = { ...host.context(), stop_propagation() { this.stopped = true; } };
  trigger(root, "restore-hidden-all", "click", {}, actionCx);
  assert.equal(actionCx.stopped, true);
  assert.equal(view.agentsFolded.has("section:hidden"), true, "Restore all must not toggle the parent category");
  assert.deepEqual(view.visibility.groups, {});
  assert.deepEqual(view.visibility.hidden, {});
  root = renderSidebar(view);
  assert.equal(findNode(root, "hidden-agents"), null);
  assertNoForbiddenHostCalls();
});

test("hidden group folding isolates local and remote members and preserves collapsed restore actions", () => {
  const remoteKey = "r:unraid-dev:/workspaces/MusicBumble";
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.groups = {
    "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null },
    [remoteKey]: { kind: "project", label: "MusicBumble", folder: "/workspaces/MusicBumble", machine: "unraid-dev" },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  const localSection = findNode(root, "hidden-group-section-local-alpha");
  const remoteSection = findNode(root, `hidden-group-section-${remoteKey}`);
  const localGroup = findNode(localSection, "hidden-group-local-alpha");
  const remoteGroup = findNode(remoteSection, `hidden-group-${remoteKey}`);
  const baselineVisibility = structuredClone(view.visibility);

  assert.ok(localSection);
  assert.ok(remoteSection);
  assert.match(textOf(localGroup), /Space: Alpha2/, "the local header counts its agent and child");
  assert.match(textOf(remoteGroup), /Project: MusicBumble @ unraid-dev1/, "the remote header keeps its member count");
  assert.equal(childrenOf(localGroup)[0].value, "mods/workspace-chrome/chevron-down.svg");
  assert.equal(childrenOf(remoteGroup)[0].value, "mods/workspace-chrome/chevron-down.svg");

  trigger(root, "hidden-group-local-alpha", "click", {}, host.context());
  assert.equal(view.agentsFolded.has("hidden:local-alpha"), true);
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), ["hidden:local-alpha"]);
  assert.deepEqual(view.visibility, baselineVisibility, "folding must not change visibility state");
  root = renderSidebar(view);
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null, "folding local groups must hide only local members");
  assert.ok(findNode(root, "hidden-agent-unraid-dev/t-remote"), "remote members must remain visible");
  assert.equal(findNode(root, "hidden-agent-t-alpha-child"), null, "collapsed groups also hide child agents");
  assert.match(textOf(findNode(root, "hidden-group-local-alpha")), /Space: Alpha2/);
  assert.equal(childrenOf(findNode(root, "hidden-group-local-alpha"))[0].value, "mods/workspace-chrome/chevron-right.svg");

  trigger(root, `hidden-group-${remoteKey}`, "click", {}, host.context());
  assert.equal(view.agentsFolded.has(`hidden:${remoteKey}`), true);
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), [
    "hidden:local-alpha",
    `hidden:${remoteKey}`,
  ]);
  assert.deepEqual(view.visibility, baselineVisibility);
  root = renderSidebar(view);
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null);
  assert.equal(findNode(root, "hidden-agent-unraid-dev/t-remote"), null);
  assert.ok(findNode(root, "hidden-group-section-local-alpha"), "local group wrapper must remain");
  assert.ok(findNode(root, `hidden-group-section-${remoteKey}`), "remote group wrapper must remain");
  assert.match(textOf(findNode(root, `hidden-group-${remoteKey}`)), /MusicBumble @ unraid-dev1/);

  trigger(root, "hidden-group-local-alpha", "click", {}, host.context());
  assert.equal(view.agentsFolded.has("hidden:local-alpha"), false);
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), [`hidden:${remoteKey}`]);
  root = renderSidebar(view);
  assert.ok(findNode(root, "hidden-agent-t-alpha"), "expanding local must not expand remote");
  assert.ok(findNode(root, "hidden-agent-t-alpha-child"), "expanding restores the child row too");
  assert.equal(findNode(root, "hidden-agent-unraid-dev/t-remote"), null);

  const stopCalls = [];
  const actionContext = {
    ...host.context(),
    stop_propagation() {
      stopCalls.push(true);
    },
  };
  trigger(root, `restore-hidden-group-${remoteKey}`, "click", {}, actionContext);
  assert.ok(stopCalls.length > 0, "the restore action must stop header click propagation");
  assert.equal(view.visibility.groups[remoteKey], undefined, "restore must act on the selected remote group");
  assert.ok(view.visibility.groups["local-alpha"], "restore must not affect the local group");
  assert.equal(view.agentsFolded.has(`hidden:${remoteKey}`), true, "restore must preserve the collapsed fold state");
  assert.deepEqual(JSON.parse(host.storage.getItem("agents.folded")), [`hidden:${remoteKey}`]);
  root = renderSidebar(view);
  assert.equal(findNode(root, `hidden-group-section-${remoteKey}`), null, "restored remote group must leave hidden rows");
  assert.ok(findNode(root, "hidden-group-section-local-alpha"), "the local hidden group must remain");
  assert.ok(findNode(root, "hidden-agent-t-alpha"), "the local member remains in the hidden list");
  assert.ok(findNode(root, "term-unraid-dev/t-remote"), "restoring remote group must reveal its live member");
  assert.deepEqual(host.calls.setAgentOrder.at(-1), ["t-alpha", "t-feature", "unraid-dev/t-remote", "t-alpha-child"]);
  assertNoForbiddenHostCalls();
});

test("hidden count and drawer members reuse one render-local snapshot without stale open state", () => {
  const visibility = emptyVisibilityState();
  visibility.hidden = { "t-alpha": {} };
  visibility.groups = {
    "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null },
  };
  const view = makeSidebar({ visibility });
  let rowCalls = 0;
  let groupCalls = 0;
  const hiddenRows = view.hiddenRows.bind(view);
  const hiddenGroups = view.hiddenGroups.bind(view);
  view.hiddenRows = (...args) => { rowCalls += 1; return hiddenRows(...args); };
  view.hiddenGroups = (...args) => { groupCalls += 1; return hiddenGroups(...args); };

  let root = renderSidebar(view);
  const closedToggle = findNode(root, "show-hidden");
  assert.ok(closedToggle);
  const closedText = textOf(closedToggle);
  const count = closedText.match(/(\d+)$/)?.[1];
  assert.ok(count, "the hidden visibility control must expose the hidden count");
  assert.equal(rowCalls, 1);
  assert.equal(groupCalls, 1);
  assert.equal(findNode(root, "hidden-agents"), null);

  trigger(root, "show-hidden", "click", {}, host.context());
  assert.equal(view.visibility.open, true);
  rowCalls = 0;
  groupCalls = 0;
  root = renderSidebar(view);
  assert.equal(rowCalls, 1);
  assert.equal(groupCalls, 1);
  assert.equal(textOf(findNode(root, "show-hidden")), `Hide hidden${count}`);
  assert.ok(findNode(root, "hidden-agents"));
  assert.ok(findNode(root, "hidden-group-local-alpha"));
  assert.ok(findNode(root, "hidden-agent-t-alpha"));

  trigger(root, "show-hidden", "click", {}, host.context());
  assert.equal(view.visibility.open, false);
  rowCalls = 0;
  groupCalls = 0;
  root = renderSidebar(view);
  assert.equal(rowCalls, 1);
  assert.equal(groupCalls, 1);
  assert.equal(textOf(findNode(root, "show-hidden")), `Show hidden${count}`);
  assert.equal(findNode(root, "hidden-agents"), null);
  assertNoForbiddenHostCalls();
});

test("inactive working sets skip group selector calculations during rendering", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {} };
  const view = makeSidebar({ visibility });
  view.groupSelector = () => { throw new Error("group selector should not run without an active working set"); };

  const root = renderSidebar(view);
  assert.equal(findNode(root, "term-t-alpha"), null);
  assert.ok(findNode(root, "term-t-feature"));
  assert.ok(findNode(root, "hidden-agents"));
  assert.ok(findNode(root, "hidden-agent-t-alpha"));
  assert.deepEqual(host.calls.setAgentOrder.at(-1), ["t-alpha", "t-feature", "unraid-dev/t-remote", "t-alpha-child"]);
  assertNoForbiddenHostCalls();
});


test("left-click agent action buttons open the correct menus without navigation", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {} };
  const root = renderSidebar(makeSidebar({ visibility }));
  const stops = [];
  const cx = { ...host.context(), stop_propagation() { stops.push(true); } };
  trigger(root, "agent-menu-t-feature", "click", {}, cx);
  trigger(root, "agent-menu-t-alpha", "click", {}, cx);
  assert.deepEqual(host.calls.openOverlay.map(item => item.props), [
    { view: "menu", tab: "agent", target: { terminal: "t-feature" } },
    { view: "menu", tab: "hidden", hidden: { kind: "agent", address: "t-alpha", recordKey: recoveryRecord.key, created_ms: 30 } },
  ]);
  assert.deepEqual(stops, [true, true]);
  assert.deepEqual(host.calls.run, []);
  assert.equal(findNode(root, "agent-menu-t-home"), null);
});

test("clicking a current hidden agent opens its live view instead of recovery", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {} };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  assert.ok(findNode(root, "hidden-agent-t-alpha"));

  trigger(root, "hidden-agent-t-alpha", "click", {}, host.context());

  assert.deepEqual(host.calls.run, [
    { name: "space.select", args: { id: "local-alpha" } },
    { name: "tab.select", args: { id: "tb-alpha" } },
    { name: "pane.focus", args: { pane: "p-alpha" } },
  ]);
  assert.deepEqual(host.calls.openOverlay, []);
  assertNoForbiddenHostCalls(host.calls.run);
});
test("clicking a live pane-less hidden agent shows the actual agent", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {} };
  const view = makeSidebar({ visibility });
  host.state.panes = host.state.panes.filter((item) => item.terminal !== "t-alpha");
  const root = renderSidebar(view);

  assert.ok(findNode(root, "hidden-agent-t-alpha"));
  trigger(root, "hidden-agent-t-alpha", "click", {}, host.context());

  assert.deepEqual(host.calls.run, [{ name: "agent.focus", args: { terminal: "t-alpha" } }]);
  assert.deepEqual(host.calls.openOverlay, []);
  assertNoForbiddenHostCalls(host.calls.run);
});
test("a matching live terminal stays focusable when the agent snapshot is absent", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {} };
  const view = makeSidebar({ visibility });
  host.state.agents = host.state.agents.filter((item) => item.address !== "t-alpha");
  const root = renderSidebar(view);

  assert.ok(findNode(root, "hidden-agent-t-alpha"));
  assert.equal(findNode(root, "recover-hidden-t-alpha"), null, "the matching live record is not saved-only");
  trigger(root, "hidden-agent-t-alpha", "click", {}, host.context());

  assert.deepEqual(host.calls.run, [
    { name: "space.select", args: { id: "local-alpha" } },
    { name: "tab.select", args: { id: "tb-alpha" } },
    { name: "pane.focus", args: { pane: "p-alpha" } },
  ]);
  assert.deepEqual(host.calls.openOverlay, []);
  assertNoForbiddenHostCalls(host.calls.run);
});

test("a hidden agent disappears on exit even with a stale agent snapshot and saved transcript", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": { recordKey: recoveryRecord.key, created_ms: 30 } };
  visibility.groups = { "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null } };
  const view = makeSidebar({ visibility, localReady: true });
  assert.ok(findNode(renderSidebar(view), "hidden-agent-t-alpha"));
  host.state.terminals = host.state.terminals.map(term => term.address === "t-alpha" ? { ...term, state: "finished" } : term);
  const root = renderSidebar(view);
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null);
  assert.equal(view.visibility.hidden["t-alpha"], undefined);
  assert.ok(host.state.shared["over9k.recovery"].records[recoveryRecord.key]);
  assert.ok(findNode(root, "recover-agents"));
  assertNoForbiddenHostCalls();
});

test("a saved-only record is not a Hidden row during startup", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": { recordKey: recoveryRecord.key, created_ms: 30 } };
  const view = makeSidebar({ visibility });
  host.state.panes = [];
  host.state.agents = [];
  host.state.terminals = [];
  const root = renderSidebar(view);
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null);
  assert.ok(view.visibility.hidden["t-alpha"], "a temporarily unavailable core does not prove closure");
  assertNoForbiddenHostCalls();
});

test("clicking an already-running saved OMP session focuses it instead of starting another tab", async () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {} };
  const sessionPath = "/tmp/omp/t-alpha-session.jsonl";
  const ompRecord = { ...recoveryRecord, key: JSON.stringify([null, "session", sessionPath]), app: "omp", sessionPath, sessionId: "t-alpha-session" };
  const view = makeSidebar({ visibility });
  host.state.terminals = host.state.terminals.map((term) => term.address === "t-alpha"
    ? { ...term, program: { ...term.program, key: "omp", name: "OMP" }, agent: "omp", foreground: { argv: ["omp", "--restore", sessionPath] } }
    : term);
  host.state.agents = host.state.agents.map((agent) => agent.address === "t-alpha" ? { ...agent, app: "omp" } : agent);
  view.recovery = { version: 1, records: { [ompRecord.key]: ompRecord } };
  renderSidebar(view);
  host.state.agents = [];
  const root = renderSidebar(view);
  const context = { ...host.context(), spawn(callback) { return Promise.resolve(callback(context)); } };

  trigger(root, "hidden-agent-t-alpha", "click", {}, context);
  assert.deepEqual(host.calls.run, [
    { name: "space.select", args: { id: "local-alpha" } },
    { name: "tab.select", args: { id: "tb-alpha" } },
    { name: "pane.focus", args: { pane: "p-alpha" } },
  ]);
  assert.equal(host.calls.run.some(({ name }) => name === "tab.new" || name === "space.new"), false);
  assert.deepEqual(host.calls.openOverlay, []);
});

test("hidden agent and collapsed group context actions open exact hidden menus without mutating sidebar state", () => {
  const alphaGroup = {
    key: "local-alpha",
    kind: "space",
    label: "Alpha",
    machine: null,
    folder: "/workspaces/Alpha",
  };
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = {
    "t-alpha": { recordKey: recoveryRecord.key, created_ms: recoveryRecord.created_ms },
  };
  visibility.groups = {
    [alphaGroup.key]: {
      kind: alphaGroup.kind,
      label: alphaGroup.label,
      machine: alphaGroup.machine,
      folder: alphaGroup.folder,
    },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  const stopCalls = [];
  const context = {
    ...host.context(),
    stop_propagation() {
      stopCalls.push(true);
    },
  };
  const baselineVisibility = structuredClone(view.visibility);

  trigger(root, "hidden-agent-t-alpha", "mouse_down:right", {}, context);
  const agentMenu = host.calls.openOverlay.at(-1);
  assert.equal(agentMenu.mod, "sidebar-overhaul");
  assert.deepEqual(agentMenu.props, {
    tab: "hidden",
    hidden: {
      kind: "agent",
      recordKey: recoveryRecord.key,
      address: "t-alpha",
      created_ms: 30,
    },
    view: "menu",
  });
  assert.ok(stopCalls.length > 0, "hidden-agent context must stop parent propagation");
  assert.deepEqual(view.visibility, baselineVisibility, "opening the hidden agent menu must not mutate visibility");
  assert.deepEqual(view.agentsFolded, new Set(), "opening the hidden agent menu must not fold rows");
  assert.deepEqual(host.calls.run, [], "opening the hidden agent menu must not focus or close anything");

  trigger(root, "hidden-group-local-alpha", "click", {}, host.context());
  assert.equal(view.agentsFolded.has("hidden:local-alpha"), true);
  root = renderSidebar(view);
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null, "the group should be collapsed before its context menu is tested");
  stopCalls.length = 0;
  trigger(root, "hidden-group-local-alpha", "mouse_down:right", {}, context);
  const groupMenu = host.calls.openOverlay.at(-1);
  assert.equal(groupMenu.mod, "sidebar-overhaul");
  assert.deepEqual(groupMenu.props, { tab: "hidden", hidden: { kind: "group", group: alphaGroup }, view: "menu" });
  assert.equal(view.agentsFolded.has("hidden:local-alpha"), true, "context must not expand or collapse a group");
  assert.deepEqual(view.visibility.groups["local-alpha"], {
    kind: "space",
    label: "Alpha",
    machine: null,
    folder: "/workspaces/Alpha",
  });
  assert.deepEqual(host.calls.exec, []);
  assert.deepEqual(host.calls.hc, []);
  assert.deepEqual(host.calls.run, []);
});
test("a live hidden removal stays pending, then dismisses after local disappearance and survives restart", () => {
  const event = {
    id: "dismiss-alpha",
    targets: [{ address: "t-alpha", created_ms: 30 }],
    recordKeys: [recoveryRecord.key],
    group: null,
  };
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = {
    "t-alpha": { recordKey: recoveryRecord.key, created_ms: 30 },
  };
  const view = makeSidebar({ visibility, hiddenRemovals: [event], localReady: true });
  let root = renderSidebar(view);
  assert.ok(findNode(root, "hidden-agent-t-alpha"), "a still-live target must remain visible while removal is pending");
  assert.deepEqual(host.state.shared["over9k.hiddenRemovals"], [event]);
  assert.equal(host.state.shared["over9k.hiddenListings"].records[recoveryRecord.key], undefined);
  assert.deepEqual(host.calls.run, [], "pending reduction must not issue native commands");

  const gone = new Set(["t-alpha", "t-alpha-child"]);
  host.state.panes = host.state.panes.filter((item) => !gone.has(item.terminal));
  host.state.agents = host.state.agents.filter((item) => !gone.has(item.address));
  host.state.terminals = host.state.terminals.filter((item) => !gone.has(item.address));
  root = renderSidebar(view);
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null, "authoritative local disappearance must remove the hidden row");
  assert.deepEqual(host.state.shared["over9k.hiddenRemovals"], []);
  assert.equal(host.state.shared["over9k.hiddenListings"].records[recoveryRecord.key], true);
  assert.ok(host.state.shared["over9k.recovery"].records[recoveryRecord.key], "dismissal must preserve recovery history");

  const dismissed = structuredClone(host.state.shared["over9k.hiddenListings"]);
  const restart = makeSidebar({ visibility, hiddenListings: dismissed, localReady: true });
  host.state.panes = host.state.panes.filter((item) => !gone.has(item.terminal));
  host.state.agents = host.state.agents.filter((item) => !gone.has(item.address));
  host.state.terminals = host.state.terminals.filter((item) => !gone.has(item.address));
  root = renderSidebar(restart);
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null, "a dismissed saved record must stay absent after restart");
  assert.ok(host.state.shared["over9k.recovery"].records[recoveryRecord.key], "restart must retain the dismissed record for recovery");
  assertNoForbiddenHostCalls();
});

test("dismissing one hidden agent leaves unrelated local and remote hidden rows intact", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = {
    "t-alpha": { recordKey: recoveryRecord.key, created_ms: 30 },
    "t-feature": {},
    "unraid-dev/t-remote": {},
  };
  const view = makeSidebar({
    visibility,
    hiddenListings: { version: 1, records: { [recoveryRecord.key]: true }, groups: {} },
    localReady: true,
  });
  const gone = new Set(["t-alpha", "t-alpha-child"]);
  host.state.panes = host.state.panes.filter((item) => !gone.has(item.terminal));
  host.state.agents = host.state.agents.filter((item) => !gone.has(item.address));
  host.state.terminals = host.state.terminals.filter((item) => !gone.has(item.address));
  const root = renderSidebar(view);

  assert.equal(findNode(root, "hidden-agent-t-alpha"), null);
  assert.ok(findNode(root, "hidden-agent-t-feature"), "the unrelated local hidden agent must remain");
  assert.ok(findNode(root, "hidden-agent-unraid-dev/t-remote"), "the unrelated remote hidden agent must remain");
  assert.ok(findNode(root, "hidden-machine-local"));
  assert.ok(findNode(root, "hidden-machine-unraid-dev"));
  assert.equal(host.state.shared["over9k.hiddenListings"].records[recoveryRecord.key], true);
  assert.ok(host.state.shared["over9k.recovery"].records[recoveryRecord.key]);
  assertNoForbiddenHostCalls();
});



test("ordinary agent clicks focus the exact pane without moving subagent rows or forcing an extra redraw", () => {
  const view = makeSidebar({ viewMode: "status" });
  const root = renderSidebar(view);
  trigger(root, "term-t-alpha", "click", { click_count: 1, modifiers: {} }, host.context());
  assert.deepEqual(host.calls.run, [{ name: "pane.focus", args: { pane: "p-alpha" } }]);
  assert.ok(view.subsOpen.has("t-alpha"));
  assert.deepEqual(host.calls.notify, []);
});

test("only the current native pane is highlighted even when another pane reports focused", () => {
  const view = makeSidebar({ viewMode: "status" });
  const space = host.state.spaces.find(item => item.id === "local-alpha");
  const feature = host.state.spaces.find(item => item.id === "local-feature");
  host.state.spaces.forEach(item => { item.active = item === space; });
  space.tabs.push(...feature.tabs);
  host.state.spaces = host.state.spaces.filter(item => item !== feature);
  for (const pane of host.state.panes) if (pane.pane === "p-alpha" || pane.pane === "p-feature") pane.focused = true;
  host.state.focused = { space: space.id, tab: "tb-feature", pane: "p-feature", terminal: "t-feature", shown: null };
  const root = renderSidebar(view);
  assert.equal(findNode(root, "term-t-feature").styles.get("bg")?.[0], host.state.theme.selected);
  assert.notEqual(findNode(root, "term-t-alpha").styles.get("bg")?.[0], host.state.theme.selected);
});

test("remote visual rows retain the native Home owner for focus and close-menu payloads", () => {
  const view = makeSidebar();
  const root = renderSidebar(view);
  const remoteRow = findNode(root, "term-unraid-dev/t-remote");
  assert.equal(textOf(findNode(root, "loose-unraid-dev-MusicBumble")).includes("MusicBumble"), true);
  const ownerBadge = findNode(remoteRow, "ownership-unraid-dev/sp-home-r:unraid-dev:/workspaces/MusicBumble");
  assert.ok(ownerBadge, "a visual/native ownership mismatch must render an owner badge");
  assert.equal(textOf(ownerBadge), "Owner: Home");

  trigger(root, "term-unraid-dev/t-remote", "click", { click_count: 1, modifiers: {} }, host.context());
  assert.deepEqual(host.calls.run, [
    { name: "pane.focus", args: { pane: "p-remote" } },
  ]);

  const fresh = makeSidebar();
  const freshRoot = renderSidebar(fresh);
  trigger(freshRoot, "term-unraid-dev/t-remote", "mouse_down:right", {}, host.context());
  assert.deepEqual(host.calls.openOverlay, [{
    mod: "sidebar-overhaul",
    kind: "popup",
    width: 220,
    height: 330,
    props: { tab: "pane", target: { pane: "p-remote", terminal: "unraid-dev/t-remote" }, view: "menu" },
  }]);
});

test("a hidden selection does not hide an unrelated terminal reusing its address", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = {
    "t-alpha": { recordKey: recoveryRecord.key, created_ms: recoveryRecord.created_ms },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  assert.equal(findNode(root, "term-t-alpha"), null);

  host.state.terminals = host.state.terminals.map((term) => term.address === "t-alpha"
    ? {
        ...term,
        created_ms: 31,
        cwd: "/workspaces/Other",
        foreground: { ...term.foreground, pid: 31, cwd: "/workspaces/Other", name: "omp" },
        labels: {
          ...term.labels,
          "revive.session": "t-alpha-new-session",
          "revive.transcript": "/tmp/omp/t-alpha-new-session.jsonl",
          "revive.cwd": "/workspaces/Other",
        },
        report: { ...term.report, seq: 31 },
      }
    : term);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"), "an unrelated terminal reusing the address must be visible");
  assertNoForbiddenHostCalls();
});

test("a verified session remains hidden when only its terminal epoch advances", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = {
    "t-alpha": { recordKey: recoveryRecord.key, created_ms: recoveryRecord.created_ms },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  assert.equal(findNode(root, "term-t-alpha"), null);

  host.state.terminals = host.state.terminals.map((term) => term.address === "t-alpha"
    ? { ...term, created_ms: 31, report: { ...term.report, seq: 31 } }
    : term);
  root = renderSidebar(view);
  assert.equal(findNode(root, "term-t-alpha"), null);
  assert.ok(findNode(root, "hidden-agent-t-alpha"));
  assertNoForbiddenHostCalls();
});

test("a rebooted native space id keeps its machine and folder hidden-group placement", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.groups = {
    "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  assert.equal(findNode(root, "term-t-alpha"), null);

  host.state.spaces = host.state.spaces.map((item) => item.id === "local-alpha"
    ? { ...item, id: "local-alpha-reboot", tabs: item.tabs.map((entry) => ({ ...entry, id: "tb-alpha-reboot" })) }
    : item);
  host.state.panes = host.state.panes.map((item) => item.pane === "p-alpha"
    ? { ...item, tab: "tb-alpha-reboot" }
    : item);
  host.state.agents = host.state.agents.map((item) => item.address === "t-alpha"
    ? { ...item, space: "local-alpha-reboot", tab: "tb-alpha-reboot" }
    : item);
  root = renderSidebar(view);

  const section = findNode(root, "hidden-group-section-local-alpha");
  assert.ok(section, "the persisted group should match the replacement space by folder");
  assert.ok(findNode(section, "hidden-agent-t-alpha"), "the hidden row should stay nested in the matching group");
  assert.equal(findNode(root, "term-t-alpha"), null);
  assertNoForbiddenHostCalls();
});

test("a remote native space id reboot preserves machine-qualified visual project hiding", () => {
  const remoteKey = "r:unraid-dev:/workspaces/MusicBumble";
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.groups = {
    [remoteKey]: { kind: "project", label: "MusicBumble", folder: "/workspaces/MusicBumble", machine: "unraid-dev" },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  assert.equal(findNode(root, "term-unraid-dev/t-remote"), null);

  host.state.spaces = host.state.spaces.map((item) => item.id === "unraid-dev/sp-home"
    ? { ...item, id: "unraid-dev/sp-home-reboot", tabs: item.tabs.map((entry) => ({ ...entry, id: "tb-remote-home-reboot" })) }
    : item);
  host.state.panes = host.state.panes.map((item) => item.pane === "p-remote"
    ? { ...item, tab: "tb-remote-home-reboot" }
    : item);
  host.state.agents = host.state.agents.map((item) => item.address === "unraid-dev/t-remote"
    ? { ...item, space: "unraid-dev/sp-home-reboot", tab: "tb-remote-home-reboot" }
    : item);
  root = renderSidebar(view);

  const section = findNode(root, `hidden-group-section-${remoteKey}`);
  assert.ok(section, "the remote hidden group should match by machine and folder");
  assert.ok(findNode(section, "hidden-agent-unraid-dev/t-remote"));
  assert.equal(findNode(root, "term-unraid-dev/t-remote"), null);
  assertNoForbiddenHostCalls();
});

test("header actions expose current selectors and recovery scope without touching native state", () => {
  const remoteKey = "r:unraid-dev:/workspaces/MusicBumble";
  const missingKey = "local-missing";
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.groups = {
    [remoteKey]: { kind: "project", label: "MusicBumble", folder: "/workspaces/MusicBumble", machine: "unraid-dev" },
    [missingKey]: { kind: "project", label: "Missing", folder: "/workspaces/Missing", machine: null },
  };
  const root = renderSidebar(makeSidebar({ visibility }));

  trigger(root, "working-sets", "click", {}, host.context());
  const workingSetDialog = host.calls.openOverlay.at(-1);
  assert.equal(workingSetDialog.mod, "sidebar-overhaul");
  assert.equal(workingSetDialog.props.view, "working-sets");
  assert.ok(workingSetDialog.props.selectors.some((item) => item.nativeKey === remoteKey));
  assert.equal(workingSetDialog.props.visibleSelectors.some((item) => item.nativeKey === remoteKey), true,
    "groups containing live agents remain visible despite saved hides");

  trigger(root, "recover-agents", "click", {}, host.context());
  const recoveryDialog = host.calls.openOverlay.at(-1);
  assert.equal(recoveryDialog.mod, "sidebar-overhaul");
  assert.deepEqual(recoveryDialog.props, { recordKey: null, view: "recovery" });

  trigger(root, `find-hidden-group-${missingKey}`, "click", {}, host.context());
  const scopedRecovery = host.calls.openOverlay.at(-1);
  assert.equal(scopedRecovery.mod, "sidebar-overhaul");
  assert.deepEqual(scopedRecovery.props, {
    view: "recovery",
    recordKey: null,
    machine: null,
    folder: "/workspaces/Missing",
    label: "Missing",
  });
  assert.deepEqual(host.calls.exec, []);
  assert.deepEqual(host.calls.hc, []);
  assert.deepEqual(host.calls.run, []);
});

test("working sets add transient exclusions while preserving manual hides after All projects", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-feature": {} };
  visibility.groups = {
    "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null },
  };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  const manualHidden = structuredClone(view.visibility.hidden["t-feature"]);
  const manualGroup = structuredClone(view.visibility.groups["local-alpha"]);
  const alphaSelector = view.allGroupSelectors().find((item) => item.nativeKey === "local-alpha");
  const homeSelector = view.allGroupSelectors().find((item) => item.nativeKey === "local-home");
  assert.ok(alphaSelector);
  assert.ok(homeSelector);
  host.state.shared["over9k.workingSets"] = {
    version: 1,
    active: "focus",
    sets: {
      focus: {
        id: "focus",
        name: "Focus",
        selectors: [alphaSelector, homeSelector],
        createdAt: 1,
        updatedAt: 1,
      },
    },
  };

  root = renderSidebar(view);
  assert.match(textOf(findNode(root, "working-sets")), /Projects: Focus/);
  assert.equal(findNode(root, "term-unraid-dev/t-remote"), null, "working-set exclusion is exclusively hidden");
  assert.ok(findNode(root, "hidden-group-section-r:unraid-dev:/workspaces/MusicBumble"));
  assert.deepEqual(view.visibility.hidden["t-feature"], manualHidden, "working sets must not rewrite manual row hides");
  assert.deepEqual(view.visibility.groups["local-alpha"], manualGroup, "working sets must not rewrite manual group hides");

  trigger(root, "clear-working-set-hidden", "click", {}, host.context());
  assert.equal(host.state.shared["over9k.workingSets"].active, null);
  root = renderSidebar(view);
  assert.match(textOf(findNode(root, "working-sets")), /Projects: All/);
  assert.ok(findNode(root, "term-unraid-dev/t-remote"), "All projects must clear only transient working-set exclusions");
  assert.equal(findNode(root, "term-t-feature"), null, "manual hide stays exclusive");
  assert.equal(findNode(root, "term-t-alpha"), null, "manual group hide stays exclusive");
  assert.deepEqual(view.visibility.hidden["t-feature"], manualHidden);
  assert.deepEqual(view.visibility.groups["local-alpha"], manualGroup);
  assert.deepEqual(host.calls.exec, []);
  assert.deepEqual(host.calls.hc, []);
  assert.deepEqual(host.calls.run, []);
});

test("only a fresh sidebar instance acknowledges its captured reload request after rendering", () => {
  const request = { status: "pending", requestId: "reload-new", requestedAt: 2 };
  const baseline = makeSidebar();
  host.state.shared["over9k.reload"] = request;
  renderSidebar(baseline);
  assert.equal(host.state.shared["over9k.reload"].status, "pending",
    "an instance without a captured request must not acknowledge a later request");

  const oldRequest = { status: "pending", requestId: "reload-old", requestedAt: 1 };
  const old = makeSidebar({ reload: oldRequest });
  host.state.shared["over9k.reload"] = request;
  renderSidebar(old);
  assert.equal(host.state.shared["over9k.reload"].status, "pending",
    "an instance captured for an older request must not acknowledge a new request");

  const fresh = makeSidebar({ reload: request });
  assert.equal(host.state.shared["over9k.reload"].status, "pending");
  renderSidebar(fresh);
  assert.equal(host.state.shared["over9k.reload"].status, "acknowledged");
  assert.equal(host.state.shared["over9k.reload"].requestId, request.requestId);
  assert.deepEqual(host.calls.exec, []);
  assert.deepEqual(host.calls.hc, []);
  assert.deepEqual(host.calls.run, []);
});

test("render diagnostics preserve an assign failure and retain it after a later success", () => {
  const view = makeSidebar();
  const originalAssign = view.assign;
  const failure = new Error("assign failed at /workspaces/Alpha/session.jsonl");
  view.assign = () => { throw failure; };

  assert.throws(() => renderSidebar(view), (error) => {
    assert.strictEqual(error, failure);
    return true;
  });

  const failed = renderDiagnostics();
  assert.equal(failed.version, 2);
  assert.equal(failed.current.status, "failure");
  assert.equal(failed.current.lastStage, "grouping");
  assert.equal(failed.current.counts.spaces, 4);
  assert.equal(failed.current.counts.panes, 4);
  assert.equal(failed.current.error.message, "assign failed at <path>");
  assert.ok(!JSON.stringify(failed).includes("/workspaces/Alpha"));

  view.assign = originalAssign;
  renderSidebar(view);
  const completed = renderDiagnostics();
  assert.equal(completed.current.status, "success");
  assert.equal(completed.failures.length, 1);
  assert.equal(completed.failures[0].status, "failure");
  assert.equal(completed.failures[0].lastStage, "grouping");
  assert.equal(completed.failures[0].counts.spaces, 4);
  assert.equal(completed.failures[0].error.message, "assign failed at <path>");
  assert.ok(!host.calls.shared.some((call) => call.key === "over9k.renderDiagnostics"));
});

test("render diagnostics preserve a grouped failure stage and bounded counts", () => {
  const view = makeSidebar();
  const originalGrouped = view.grouped;
  const failure = new Error("grouped failed at https://example.test/private");
  view.grouped = () => { throw failure; };

  assert.throws(() => renderSidebar(view), (error) => {
    assert.strictEqual(error, failure);
    return true;
  });

  const failed = renderDiagnostics();
  assert.equal(failed.current.status, "failure");
  assert.equal(failed.current.lastStage, "list-build");
  assert.equal(typeof failed.current.counts.spaces, "number");
  assert.equal(typeof failed.current.counts.groups, "number");
  assert.equal(failed.current.error.message, "grouped failed at <url>");

  view.grouped = originalGrouped;
  renderSidebar(view);
  const completed = renderDiagnostics();
  assert.equal(completed.current.status, "success");
  assert.equal(completed.failures.length, 1);
  assert.equal(completed.failures[0].lastStage, "list-build");
  assert.equal(completed.failures[0].counts.groups, failed.current.counts.groups);
});
test("a working agent starts in Working even when its space and agent were hidden", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {} };
  visibility.groups = { "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null } };
  const view = makeSidebar({ viewMode: "status", visibility });
  reportStatus(["t-alpha"], "working");
  const root = renderSidebar(view);
  assert.match(textOf(findNode(root, "section-working")), /Working1/);
  assert.ok(findNode(root, "term-t-alpha"));
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null);
  assert.ok(findNode(root, "hidden-agent-t-alpha-child"), "the idle sibling stays hidden");
  assertNoForbiddenHostCalls();
});

test("blocked transition reveals target while explicit sibling remains hidden", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {}, "t-feature": {} };
  const view = makeSidebar({ visibility });
  renderSidebar(view);
  host.state.agents = host.state.agents.map((agent) => agent.address === "t-alpha" ? { ...agent, status: "blocked" } : agent);
  const root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"));
  assert.equal(findNode(root, "term-t-feature"), null, "hidden sibling stays exclusively hidden");
});

test("manual restore reveals a group-hidden target and focuses its actual owning space", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.groups = { "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null } };
  const view = makeSidebar({ visibility });
  let root = renderSidebar(view);
  assert.equal(findNode(root, "term-t-alpha"), null);
  trigger(root, "restore-hidden-t-alpha", "click", {}, host.context());
  assert.deepEqual(host.calls.run.slice(-3), [
    { name: "space.select", args: { id: "local-alpha" } },
    { name: "tab.select", args: { id: "tb-alpha" } },
    { name: "pane.focus", args: { pane: "p-alpha" } },
  ]);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"));
  assert.equal(view.isHiddenAgent("t-alpha-child"), true, "unrelated hidden sibling stays hidden");
});

test("a hide request never suppresses a still-working agent", () => {
  const view = makeSidebar();
  renderSidebar(view);
  view.setVisibilityAction({ type: "hide", address: "t-alpha" });
  const root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"));
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null);
  assertNoForbiddenHostCalls();
});
test("a pending explicit launch reveals the new shell before agent status arrives", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.groups = { "local-alpha": { kind: "space", label: "Alpha", folder: "/workspaces/Alpha", machine: null } };
  const view = makeSidebar({ visibility });
  renderSidebar(view);
  host.state.shared[VISIBILITY_ACTIONS] = [{ type: "reveal-launch", machine: null, folder: "/workspaces/Alpha", before: host.state.terminals.map((term) => term.address) }];
  renderSidebar(view);
  assert.equal(host.state.shared[VISIBILITY_ACTIONS].length, 1);
  host.state.terminals.push({ ...host.state.terminals.find((term) => term.address === "t-alpha"), address: "t-launched", created_ms: 99, status: "idle", program: shellProgram });
  renderSidebar(view);
  assert.deepEqual(host.state.shared[VISIBILITY_ACTIONS], []);
  assert.equal(view.isHiddenAgent("t-launched"), false);
  assert.equal(view.isHiddenAgent("t-alpha"), true);
  assert.equal(view.isHiddenGroup("local-alpha"), false);
  assert.deepEqual(host.calls.run, []);
});
for (const options of [["-N", "-T"], ["-NT"], ["-o", "SessionType=none"], ["-oSessionType=none"], ["-O", "check"]]) {
  test(`forwarding-only SSH ${options.join(" ")} does not duplicate a local agent remotely`, async () => {
    const view = makeSidebar({ viewMode: "space" });
    sshScanOutput = ["t-alpha", "/workspaces/Alpha", "ssh", ...options, "-L", "127.0.0.1:19432:127.0.0.1:19432", "unraid-dev"].join("\t");
    try {
      await view.findSsh();
      assert.equal(view.sshedTo("t-alpha", "self"), null);
      const root = renderSidebar(view);
      assert.ok(findNode(root, "term-t-alpha"));
      assert.deepEqual(view.sshRows("unraid-dev", host.herdr.theme()), []);
    } finally { sshScanOutput = null; }
  });
}

test("SSH executing remote work still exposes its remote visitor", async () => {
  const view = makeSidebar({ viewMode: "space" });
  sshScanOutput = ["t-alpha", "/workspaces/Alpha", "ssh", "-T", "-L", "127.0.0.1:19432:127.0.0.1:19432", "unraid-dev", "cd /workspaces/MusicBumble && omp"].join("\t");
  try {
    await view.findSsh();
    assert.equal(view.sshedTo("t-alpha", "self"), "unraid-dev");
    assert.deepEqual(view.sshTo["t-alpha"].paths, ["/workspaces/MusicBumble"]);
  } finally { sshScanOutput = null; }
});

test("canonical live children and unlabeled status terminals render once with fold and hide bypass", () => {
  const child = reviveTerminal({ address: "t-alpha-child", cwd: "/workspaces/Alpha/child", parent: "t-alpha", program: codexProgram, title: "Codex - child", status: "working", name: "Alpha child", created: 31 });
  const remoteChild = reviveTerminal({ address: "unraid-dev/t-remote-child", cwd: "/workspaces/MusicBumble/child", parent: "unraid-dev/t-remote", program: shellProgram, title: "helper", status: "idle", name: "Remote child", created: 51 });
  remoteChild.agent = "helper";
  remoteChild.program = shellProgram;
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = {};
  visibility.groups = {};
  const view = makeSidebar({ viewMode: "space", visibility });
  host.state.terminals = host.state.terminals.filter(term => term.address !== child.address);
  host.state.terminals.push(child, remoteChild);
  view.agentsFolded.add("local-alpha");
  view.folded.add(null);
  let root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"));
  assert.ok(findNode(root, "agent-t-alpha-child"));
  assert.ok(findNode(root, "agent-unraid-dev/t-remote-child"));
  assert.equal(findNode(root, "kid-t-alpha-child"), null);
  assert.equal(findNode(root, "visit-t-alpha-child"), null);
  assert.equal(host.calls.setAgentOrder.at(-1).filter((address) => address === "t-alpha-child").length, 1);
  trigger(root, "agent-unraid-dev/t-remote-child", "click", { click_count: 1, modifiers: {} }, host.context());
  assert.deepEqual(host.calls.run.at(-1), { name: "terminal.peek", args: { terminal: "unraid-dev/t-remote-child" } });
  view.restoreView("status");
  root = renderSidebar(view);
  assert.ok(findNode(root, "agent-t-alpha-child"));
  assert.ok(findNode(root, "agent-unraid-dev/t-remote-child"));
});
test("live children remain visible when parent groups and machine headings are folded", () => {
  const child = reviveTerminal({ address: "t-alpha-child", cwd: "/workspaces/Alpha/child", parent: "t-alpha", program: codexProgram, title: "Codex - child", status: "working", name: "Alpha child", created: 31 });
  const view = makeSidebar({ viewMode: "space" });
  host.state.terminals = host.state.terminals.filter(term => term.address !== child.address);
  host.state.terminals.push(child);
  view.agentsFolded.add("local-alpha");
  view.folded.add(null);
  const root = renderSidebar(view);
  assert.ok(findNode(root, "agent-t-alpha-child"), "live child remains visible through group folds");
  assert.ok(findNode(root, "term-t-alpha"), "live parent remains visible through group folds");
});
test("hidden inactive agents move exclusively to Working then Idle after observed activity", () => {
  const visibility = emptyVisibilityState();
  visibility.open = true;
  visibility.hidden = { "t-alpha": {} };
  const view = makeSidebar({ viewMode: "status", visibility });
  host.state.agents = host.state.agents.map(a => a.address === "t-alpha" ? { ...a, status: "idle" } : a);
  host.state.terminals = host.state.terminals.map(t => t.address === "t-alpha" ? { ...t, status: "idle" } : t);
  let root = renderSidebar(view);
  assert.ok(findNode(root, "hidden-agent-t-alpha"));
  assert.equal(findNode(root, "term-t-alpha"), null);
  host.state.agents = host.state.agents.map(a => a.address === "t-alpha" ? { ...a, status: "working" } : a);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"));
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null);
  assert.equal(view.presentation.effective["t-alpha"].status, "working");
  host.state.agents = host.state.agents.map(a => a.address === "t-alpha" ? { ...a, status: "idle" } : a);
  root = renderSidebar(view);
  assert.ok(findNode(root, "term-t-alpha"));
  assert.equal(findNode(root, "hidden-agent-t-alpha"), null);
  assert.equal(view.presentation.effective["t-alpha"].status, "idle");
});

test("agent rows omit program logos but retain status and shell indicators", () => {
  const view = makeSidebar({ viewMode: "space" });
  host.state.agents = host.state.agents.map(a => ({ ...a, program: { ...a.program, icon: "icons/agent-logo.svg", tint: true } }));
  host.state.panes = host.state.panes.map(p => p.terminal === "t-alpha" ? { ...p, program: { ...p.program, icon: "icons/agent-logo.svg", tint: true } } : p);
  const root = renderSidebar(view);
  const nodes = node => [node, ...childrenOf(node).flatMap(nodes)];
  const assets = node => nodes(node).filter(n => n && (n.kind === "svg" || n.kind === "image")).map(n => n.value);
  const row = findNode(root, "term-t-alpha");
  assert.ok(row);
  assert.equal(assets(row).includes("icons/agent-logo.svg"), false);
  assert.ok(assets(row).includes("mods/workspace-chrome/spinner.svg"), "working status remains visible");
  assert.ok(assets(findNode(root, "term-t-home")).includes("icons/shell.svg"), "plain shells retain their icon");
});

test("automatic project pinning honors explicit per-machine false over legacy true", () => {
  const view = makeSidebar();
  const config = {
    version: 1,
    machines: {
      local: { worktreeDirectory: "/home/dev/.herdr/worktrees", locations: { chats: "~", projects: "~" }, projects: { pinned: [], hidden: [], unpinned: [], listed: [] }, options: { keepUpToDate: false } },
      "unraid-dev": { worktreeDirectory: "/workspaces/.herdr/worktrees", locations: { chats: "~", projects: "/workspaces" }, projects: { pinned: [], hidden: [], unpinned: [], listed: [] }, options: { keepUpToDate: false } },
    },
    repositories: {},
    options: { keepUpToDate: true },
  };
  publishSidebarConfig({ config });
  try {
    view.config = config;
    view.autoPin(["/workspaces/NewLocal"]);
    view.autoPin(["/workspaces/NewRemote"], "unraid-dev");
    assert.deepEqual(host.state.shared["projects.pinned"], ["/workspaces/Alpha"]);
    assert.deepEqual(host.state.shared["projects.on"]["unraid-dev"].pinned, []);
  } finally { clearSidebarConfigCache(); }
});
