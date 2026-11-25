import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import {
  buildClosePlan,
  captureRecoveryRecord,
  closePlanIdentity,
  visualSnapshotIdentity,
} from "./close-plan-core.js";
import {
  createNativeTestHost,
  textOf,
  trigger,
} from "../over9k/native-test-host.js";

const host = createNativeTestHost();
let activeProps = {};
host.herdr.props = () => ({ ...activeProps });
host.herdr.closeOverlay = () => null;
globalThis.localStorage = host.storage;
globalThis.sessionStorage = host.storage;
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => host.gpuiBase);
mock.module("herdr", () => host.herdr);
const { default: CloseConfirm } = await import("./main.js");

const agentProgram = { key: "claude", name: "Claude Code", agent: true };
const childProgram = { key: "codex", name: "Codex", agent: true };
const shellProgram = { key: "zsh", name: "zsh", agent: false, shell: true };

function fixture() {
  return {
    spaces: [{ id: "space-home", name: "Home", folder: "/home/dev", machine: null, tabs: [{ id: "tab-main", name: "Main", panes: 2 }] }],
    panes: [
      { pane: "pane-agent", terminal: "t-agent", tab: "tab-main", cwd: "/workspaces/Visual" },
      { pane: "pane-mod", terminal: "t-mod", tab: "tab-main", cwd: "/home/dev" },
    ],
    agents: [
      { address: "t-agent", title: "Visible root", status: "working", space: "space-home" },
      { address: "t-child", title: "Hidden idle child", status: "idle", hidden: true, space: "space-home" },
    ],
    terminals: [
      { address: "t-agent", created_ms: 10, parent: null, program: agentProgram, status: "working", cwd: "/workspaces/Visual", foreground: { argv: ["claude"] } },
      { address: "t-child", created_ms: 11, parent: "t-agent", program: childProgram, status: "idle", cwd: "/workspaces/Visual", foreground: { argv: ["codex"] } },
      { address: "t-mod", created_ms: 12, parent: null, program: shellProgram, status: "idle", cwd: "/home/dev", foreground: { argv: ["zsh"] } },
    ],
    now: 100,
  };
}
function hiddenFixture() {
  const data = {
    spaces: [{ id: "remote-home", name: "Home", folder: "/home/dev", machine: "remote", tabs: [{ id: "remote-tab", name: "Main", panes: 2 }] }],
    panes: [{ pane: "remote-music-pane", terminal: "remote/music-root", tab: "remote-tab", cwd: "/home/dev/MusicBumble" }],
    agents: [
      { address: "remote/music-root", title: "Music root", status: "working", space: "remote-home" },
      { address: "remote/music-child", title: "Music child", status: "idle", hidden: true, space: "remote-home" },
      { address: "remote/home-root", title: "Home sibling", status: "idle", space: "remote-home" },
    ],
    terminals: [
      { address: "remote/music-root", created_ms: 20, parent: null, state: "live", program: agentProgram, status: "working", cwd: "/home/dev/MusicBumble", foreground: { argv: ["claude"], cwd: "/home/dev/MusicBumble" } },
      { address: "remote/music-child", created_ms: 21, parent: "remote/music-root", state: "live", program: childProgram, status: "idle", cwd: "/home/dev/MusicBumble", foreground: { argv: ["codex"], cwd: "/home/dev/MusicBumble" } },
      { address: "remote/music-shell", created_ms: 22, parent: "remote/music-root", state: "live", program: shellProgram, status: "idle", cwd: "/home/dev/MusicBumble", foreground: { argv: ["zsh"], cwd: "/home/dev/MusicBumble" } },
      { address: "remote/home-root", created_ms: 30, parent: null, state: "live", program: agentProgram, status: "idle", cwd: "/home/dev/MusicBumble", foreground: { argv: ["claude"], cwd: "/home/dev/MusicBumble" } },
    ],
    machines: [{ name: "remote", layout: "ready" }, { name: null, layout: "ready" }],
    shared: {},
    visibility: { version: 1, groups: {}, hidden: {}, effective: {}, groupEffective: {} },
    now: 100,
  };
  data.visualGroups = {
    version: 1,
    identity: visualSnapshotIdentity(data),
    groups: [{
      key: "project:remote-music",
      kind: "project",
      label: "MusicBumble",
      machine: "remote",
      folder: "/home/dev/MusicBumble",
      members: [
        { address: "remote/music-root", created_ms: 20 },
        { address: "remote/music-child", created_ms: 21 },
        { address: "remote/music-shell", created_ms: 22 },
      ],
    }],
  };
  data.shared["over9k.visualGroups"] = data.visualGroups;
  return data;
}

function hiddenGroup() {
  return { key: "project:remote-music", kind: "project", label: "MusicBumble", machine: "remote", folder: "/home/dev/MusicBumble" };
}

function savedRecord({ key = "saved-remote", address = "remote/saved", created_ms = 10, title = "Saved remote", group = hiddenGroup() } = {}) {
  return {
    key,
    machine: "remote",
    address,
    created_ms,
    title,
    app: "claude",
    cwd: group.folder,
    owner: { id: "remote-home", name: "Home", folder: "/home/dev" },
    visual: { key: group.key, kind: group.kind, label: group.label, machine: group.machine, folder: group.folder },
    sessionId: null,
    sessionPath: null,
    verified: false,
    lastSeen: 90,
  };
}

function cx() {
  return { focus_handle: () => ({ focus() {} }) };
}

function controller(selection, data = fixture()) {
  host.reset(data);
  activeProps = { ...selection, overlay: "test-overlay" };
  const view = new CloseConfirm();
  view.init(null, cx());
  return view;
}

test("pane ownership stays native while visual group follows cwd", () => {
  const p = buildClosePlan({ panes: ["pane-agent"] }, fixture());
  const root = p.affectedAgents.find((record) => record.address === "t-agent");
  assert.equal(root.owner.id, "space-home");
  assert.equal(root.visual.kind, "project");
  assert.equal(root.visual.folder, "/workspaces/Visual");
  assert.equal(root.visual.label, "Visual");
});

test("hidden idle descendants are included and mod panes stay open", () => {
  const p = buildClosePlan({ panes: ["pane-agent"] }, fixture());
  assert.deepEqual(p.affectedAgents.map((record) => record.title), ["Visible root", "Hidden idle child"]);
  assert.equal(p.agentStatuses.find((item) => item.address === "t-child").status, "idle");
  assert.ok(p.commands.some((command) => command.name === "pane.close" && command.args.pane === "pane-agent"));
  assert.ok(p.commands.some((command) => command.name === "terminal.kill" && command.args.terminal === "t-child"));
  assert.ok(!p.commands.some((command) => command.name === "pane.close" && command.args.pane === "pane-mod"));
  assert.ok(!p.commands.some((command) => command.name === "tab.close"));
  assert.ok(!p.commands.some((command) => command.name === "space.close"));

  const incomplete = fixture();
  incomplete.panes = incomplete.panes.filter((pane) => pane.pane !== "pane-mod");
  const guarded = buildClosePlan({ panes: ["pane-agent"] }, incomplete);
  assert.ok(!guarded.commands.some((command) => command.name === "tab.close"));
});

test("incarnation changes invalidate the confirmation identity", () => {
  const before = buildClosePlan({ panes: ["pane-agent"] }, fixture());
  const afterData = fixture();
  afterData.terminals = afterData.terminals.map((term) => term.address === "t-agent" ? { ...term, created_ms: 99 } : term);
  const after = buildClosePlan({ panes: ["pane-agent"] }, afterData);
  assert.notEqual(closePlanIdentity(before), closePlanIdentity(after));
});

test("foreground argv does not inherit an old restore wrapper", () => {
  const data = fixture();
  data.terminals = data.terminals.map((term) => term.address === "t-agent"
    ? { ...term, argv: ["omp", "--restore", "/old-session.jsonl"], foreground: { argv: ["omp"] } }
    : term);
  const p = buildClosePlan({ panes: ["pane-agent"] }, data);
  const root = p.affectedAgents.find((record) => record.address === "t-agent");
  assert.equal(root.sessionPath, null);
  assert.equal(root.verified, false);
  assert.equal(root.key, JSON.stringify([null, "terminal", "t-agent", 10]));
});

test("shell foreground ignores stale Revive session labels", () => {
  const data = fixture();
  data.terminals = data.terminals.map((term) => term.address === "t-agent"
    ? {
      ...term,
      foreground: { argv: ["zsh"] },
      labels: { "revive.session": "stale", "revive.transcript": "/old-session.jsonl" },
    }
    : term);
  const p = buildClosePlan({ panes: ["pane-agent"] }, data);
  const root = p.affectedAgents.find((record) => record.address === "t-agent");
  assert.equal(root.sessionId, null);
  assert.equal(root.sessionPath, null);
  assert.equal(root.verified, false);
});

test("recovery records whitelist identity and display fields", () => {
  const record = captureRecoveryRecord({
    terminal: {
      address: "t-agent",
      created_ms: 10,
      argv: ["omp", "--restore", "/tmp/private.jsonl", "--api-key=secret"],
      labels: { "revive.transcript": "/tmp/private.jsonl", "secret": "must not persist" },
      program: agentProgram,
    },
    agent: { address: "t-agent", title: "Visible root", status: "working" },
    owner: { id: "space-home", name: "Home", folder: "/home/dev" },
    lastSeen: 100,
  });
  assert.deepEqual(Object.keys(record).sort(), ["address", "app", "created_ms", "cwd", "key", "lastSeen", "machine", "owner", "sessionId", "sessionPath", "title", "verified", "visual"].sort());
  assert.equal("argv" in record, false);
  assert.equal("labels" in record, false);
});

test("subrows remain in the plan until consent", () => {
  const p = buildClosePlan({ subs: [{ kind: "agent", agent: "t-child" }] }, fixture());
  assert.equal(p.subRows.length, 1);
  assert.equal(p.requiresConfirmation, true);
  assert.ok(!p.commands.some((command) => command.name === "closeSubs"));
  assert.ok(!Object.values(p).some((value) => value && typeof value === "object" && value.closeSubs));
});

test("cancel performs no destructive command or recovery write", () => {
  const view = controller({ panes: ["pane-agent"] });
  const tree = view.render(cx());
  trigger(tree, "no", "click");
  assert.deepEqual(host.calls.run, []);
  assert.deepEqual(host.calls.shared, []);
});

test("changed membership requires a second confirmation", () => {
  const view = controller({ panes: ["pane-agent"] });
  host.state.terminals = host.state.terminals.filter((term) => term.address !== "t-child");
  host.state.agents = host.state.agents.filter((agent) => agent.address !== "t-child");
  view.yes();
  assert.deepEqual(host.calls.run, []);
  assert.equal(view.notice, "The affected set changed. Review the complete list, then confirm again.");
  view.yes();
  assert.ok(host.calls.shared.some((call) => call.key === "over9k.recovery"));
  assert.ok(host.calls.run.length > 0);
  assert.ok(Object.keys(host.state.shared["over9k.recovery"].records).length > 0);
});

test("dialog renders every affected agent with owner and visual group", () => {
  const view = controller({ panes: ["pane-agent"] });
  const text = textOf(view.render(cx()));
  assert.match(text, /Visible root/);
  assert.match(text, /Hidden idle child/);
  assert.match(text, /Actual:.*Home/);
  assert.match(text, /Shown:.*Visual/);
});

test("consented subrows publish only after recovery capture", () => {
  const view = controller({ subs: [{ kind: "agent", agent: "t-child" }] });
  assert.deepEqual(host.calls.shared, []);
  view.yes();
  assert.deepEqual(host.calls.shared.map((call) => call.key), ["over9k.recovery", "over9k.closeSubs"]);
  assert.deepEqual(host.calls.run, []);
});

test("hidden project closes only projected members and every descendant", () => {
  const p = buildClosePlan({ hidden: { kind: "group", group: hiddenGroup() } }, hiddenFixture());
  assert.deepEqual(p.commands.map((command) => command.args.terminal), [
    "remote/music-root",
    "remote/music-child",
    "remote/music-shell",
  ]);
  assert.ok(!p.commands.some((command) => command.args.terminal === "remote/home-root"));
  assert.deepEqual(p.agentStatuses.map((item) => item.address), ["remote/music-root", "remote/music-child"]);
  assert.deepEqual(p.hiddenRemoval.targets.map((target) => target.address), [
    "remote/music-child",
    "remote/music-root",
    "remote/music-shell",
  ]);
  assert.equal(p.spaces, 0);
  assert.equal(p.target.panes.length, 0);
});
test("hidden group removal remains available when projection is stale but issues no close commands", () => {
  const data = hiddenFixture();
  data.shared["over9k.visualGroups"].identity = "stale";
  const p = buildClosePlan({ hidden: { kind: "group", group: hiddenGroup() } }, data);
  assert.equal(p.blocked, false, p.error ?? "no blocker reason");
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.hiddenRemoval.targets, []);
  assert.deepEqual(p.hiddenRemoval.recordKeys, []);
  assert.deepEqual(p.hiddenRemoval.group, {
    key: "project:remote-music",
    kind: "project",
    machine: "remote",
    folder: "/home/dev/MusicBumble",
  });
});

test("hidden group removes saved records without requiring the remote machine to be ready", () => {
  const data = hiddenFixture();
  const record = savedRecord({ key: "offline-saved", address: "remote/offline-saved" });
  data.recovery = { version: 1, records: { [record.key]: record } };
  data.machines = [{ name: "remote", layout: "unavailable" }];
  data.terminals = [];
  data.panes = [];
  data.agents = [];
  data.visualGroups = { version: 1, identity: visualSnapshotIdentity(data), groups: [] };
  data.shared["over9k.visualGroups"] = data.visualGroups;
  const p = buildClosePlan({ hidden: { kind: "group", group: hiddenGroup() } }, data);
  assert.equal(p.blocked, false);
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.hiddenRemoval.targets, []);
  assert.deepEqual(p.hiddenRemoval.recordKeys, [record.key]);
  assert.deepEqual(p.hiddenRemoval.group, {
    key: "project:remote-music",
    kind: "project",
    machine: "remote",
    folder: "/home/dev/MusicBumble",
  });
});


test("hidden confirmation identity ignores capture timestamps", () => {
  const beforeData = hiddenFixture();
  const afterData = hiddenFixture();
  afterData.now = 999999;
  const before = buildClosePlan({ hidden: { kind: "agent", address: "remote/music-root", created_ms: 20 } }, beforeData);
  const after = buildClosePlan({ hidden: { kind: "agent", address: "remote/music-root", created_ms: 20 } }, afterData);
  assert.deepEqual(after.hiddenRemoval, before.hiddenRemoval);
  assert.equal(closePlanIdentity(after), closePlanIdentity(before));
});

test("hidden group falls back from a rebooted native key only when metadata is unique", () => {
  const data = hiddenFixture();
  const p = buildClosePlan({
    hidden: {
      kind: "group",
      group: { ...hiddenGroup(), key: "space-before-reboot" },
    },
  }, data);
  assert.ok(p.commands.some((command) => command.args.terminal === "remote/music-root"));
  assert.equal(p.blocked, false);
});

test("hidden group membership changes require a second confirmation", () => {
  const data = hiddenFixture();
  const view = controller({ hidden: { kind: "group", group: hiddenGroup() } }, data);
  const newTerm = { address: "remote/music-new", created_ms: 23, parent: "remote/music-root", state: "live", program: childProgram, status: "idle", cwd: "/home/dev/MusicBumble", foreground: { argv: ["codex"], cwd: "/home/dev/MusicBumble" } };
  host.state.terminals.push(newTerm);
  host.state.agents.push({ address: newTerm.address, title: "New music child", status: "idle", space: "remote-home" });
  host.state.shared["over9k.visualGroups"].groups[0].members.push({ address: newTerm.address, created_ms: newTerm.created_ms });
  host.state.shared["over9k.visualGroups"].identity = visualSnapshotIdentity(host.state);
  view.yes();
  assert.deepEqual(host.calls.run, []);
  assert.deepEqual(host.calls.shared, []);
  assert.equal(view.notice, "The affected set changed. Review the complete list, then confirm again.");
  view.yes();
  assert.ok(host.calls.run.some((call) => call.args.terminal === newTerm.address));
  assert.deepEqual(host.calls.shared.map((call) => call.key), ["over9k.recovery", "over9k.hiddenRemovals"]);
});

test("dismissed missing group records stay hidden while reopened live records remain targets", () => {
  const data = hiddenFixture();
  const missing = savedRecord({ key: "dismissed-missing", address: "remote/missing", created_ms: 40, title: "Dismissed missing" });
  const reopened = savedRecord({ key: "dismissed-reopened", address: "remote/music-root", created_ms: 20, title: "Reopened music root" });
  data.recovery = { version: 1, records: { [missing.key]: missing, [reopened.key]: reopened } };
  data.hiddenListings = { version: 1, records: { [missing.key]: true, [reopened.key]: true }, groups: {} };
  data.visualGroups.identity = visualSnapshotIdentity(data);
  const p = buildClosePlan({ hidden: { kind: "group", group: hiddenGroup() } }, data);
  assert.ok(p.commands.some((command) => command.args.terminal === reopened.address));
  assert.ok(!p.hiddenSaved.some((record) => record.key === missing.key));
  assert.ok(p.hiddenRemoval.recordKeys.includes(reopened.key));
  assert.ok(!p.hiddenRemoval.recordKeys.includes(missing.key));
  assert.ok(data.recovery.records[missing.key]);
});

test("hidden agent stale address reuse never kills the new incarnation", () => {
  const data = hiddenFixture();
  const record = savedRecord({ key: "old-incarnation", address: "remote/music-root", created_ms: 20, title: "Old music root" });
  data.recovery = { version: 1, records: { [record.key]: record } };
  data.shared["over9k.recovery"] = data.recovery;
  data.terminals = data.terminals.map((term) => term.address === "remote/music-root" ? { ...term, created_ms: 99 } : term);
  data.agents = data.agents.map((agent) => agent.address === "remote/music-root" ? { ...agent, title: "Reused music root" } : agent);
  data.visualGroups.identity = visualSnapshotIdentity(data);
  const p = buildClosePlan({ hidden: { kind: "agent", recordKey: record.key, address: record.address, created_ms: record.created_ms } }, data);
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.hiddenRemoval.targets, []);
  assert.deepEqual(p.hiddenSaved.map((item) => item.title), ["Old music root"]);
});

test("a missing recovery record does not block closing an exact live hidden agent", () => {
  const data = hiddenFixture();
  data.recovery = { version: 1, records: {} };
  data.shared["over9k.recovery"] = data.recovery;
  const hidden = { kind: "agent", recordKey: "missing-record", address: "remote/music-root", created_ms: 20 };
  const p = buildClosePlan({ hidden }, data);
  assert.equal(p.blocked, false, p.error ?? "no blocker reason");
  assert.ok(p.commands.some((command) => command.name === "terminal.kill" && command.args.terminal === hidden.address));
  assert.ok(p.hiddenRemoval.targets.some((target) => target.address === hidden.address && target.created_ms === hidden.created_ms));
  assert.ok(p.hiddenRemoval.recordKeys.includes(hidden.recordKey));

  const view = controller({ hidden }, data);
  view.yes();
  assert.ok(host.calls.run.some((call) => call.name === "terminal.kill" && call.args.terminal === hidden.address));
  const event = host.state.shared["over9k.hiddenRemovals"][0];
  assert.ok(event.recordKeys.includes(hidden.recordKey));
  assert.ok(event.targets.some((target) => target.address === hidden.address && target.created_ms === hidden.created_ms));
});

test("a missing saved-only hidden record can be removed without attempting a kill", () => {
  const data = hiddenFixture();
  data.recovery = { version: 1, records: {} };
  data.shared["over9k.recovery"] = data.recovery;
  const p = buildClosePlan({ hidden: { kind: "agent", recordKey: "missing-saved-record" } }, data);
  assert.equal(p.blocked, false, p.error ?? "no blocker reason");
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.hiddenRemoval.targets, []);
  assert.deepEqual(p.hiddenRemoval.recordKeys, ["missing-saved-record"]);
});

test("a missing recovery record never lets a reused hidden address kill a new incarnation", () => {
  const data = hiddenFixture();
  data.recovery = { version: 1, records: {} };
  data.shared["over9k.recovery"] = data.recovery;
  data.terminals = data.terminals.map((term) => term.address === "remote/music-root" ? { ...term, created_ms: 99 } : term);
  const p = buildClosePlan({ hidden: { kind: "agent", recordKey: "missing-old-record", address: "remote/music-root", created_ms: 20 } }, data);
  assert.equal(p.blocked, false);
  assert.ok(!p.commands.some((command) => command.args.terminal === "remote/music-root"));
  assert.deepEqual(p.hiddenRemoval.targets, [], "a reused terminal incarnation is never included in removal targets");
  assert.ok(p.hiddenRemoval.recordKeys.includes("missing-old-record"));
});

test("saved-only hidden entries remove a listing without killing a terminal", () => {
  const data = hiddenFixture();
  const record = savedRecord();
  data.recovery = { version: 1, records: { [record.key]: record } };
  data.shared["over9k.recovery"] = data.recovery;
  data.terminals = data.terminals.filter((term) => term.address !== record.address);
  data.visualGroups.identity = visualSnapshotIdentity(data);
  const p = buildClosePlan({ hidden: { kind: "agent", recordKey: record.key, address: record.address, created_ms: record.created_ms } }, data);
  assert.equal(p.requiresConfirmation, true);
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.hiddenRemoval.targets, []);
  assert.equal(p.hiddenSaved[0].title, "Saved remote");
});

test("legacy saved-only records with nullable creation can be removed when ready", () => {
  const data = hiddenFixture();
  const record = savedRecord({ key: "legacy-remote", address: "remote/legacy", created_ms: null, title: "Legacy remote" });
  data.recovery = { version: 1, records: { [record.key]: record } };
  data.hiddenListings = { version: 1, records: {}, groups: {} };
  data.machines = [{ name: "remote", layout: "ready" }];
  data.terminals = data.terminals.filter((term) => term.address !== record.address);
  data.visualGroups.identity = visualSnapshotIdentity(data);
  const p = buildClosePlan({ hidden: { kind: "agent", recordKey: record.key, address: record.address } }, data);
  assert.equal(p.blocked, false);
  assert.equal(p.requiresConfirmation, true);
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.hiddenRemoval.targets, []);
  assert.deepEqual(p.hiddenSaved.map((item) => item.key), [record.key]);
});

test("unknown or offline machine does not block removing a saved hidden entry", () => {
  const data = hiddenFixture();
  const record = savedRecord();
  data.recovery = { version: 1, records: { [record.key]: record } };
  data.terminals = data.terminals.filter((term) => term.address !== record.address);
  data.machines = [{ name: "remote", layout: "unavailable" }];
  data.visualGroups.identity = visualSnapshotIdentity(data);
  const p = buildClosePlan({ hidden: { kind: "agent", recordKey: record.key, address: record.address, created_ms: record.created_ms } }, data);
  assert.equal(p.blocked, false);
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.hiddenRemoval.targets, []);
  assert.deepEqual(p.hiddenRemoval.recordKeys, [record.key]);
});

test("saved-only entries are shown separately in the close dialog", () => {
  const data = hiddenFixture();
  const record = savedRecord();
  data.recovery = { version: 1, records: { [record.key]: record } };
  data.shared["over9k.recovery"] = data.recovery;
  data.terminals = data.terminals.filter((term) => term.address !== record.address);
  data.visualGroups.identity = visualSnapshotIdentity(data);
  const view = controller({ hidden: { kind: "agent", recordKey: record.key, address: record.address, created_ms: record.created_ms } }, data);
  assert.match(textOf(view.render(cx())), /Saved listing/);
  assert.match(textOf(view.render(cx())), /Saved remote/);
});

test("hidden cancellation writes neither recovery nor removal queue", () => {
  const view = controller({ hidden: { kind: "agent", address: "remote/music-root", created_ms: 20 } }, hiddenFixture());
  trigger(view.render(cx()), "no", "click");
  assert.deepEqual(host.calls.run, []);
  assert.deepEqual(host.calls.shared, []);
});

test("hidden consent captures recovery, dispatches exact kills, then queues removal", () => {
  const view = controller({ hidden: { kind: "agent", address: "remote/music-root", created_ms: 20 } }, hiddenFixture());
  view.yes();
  assert.equal(host.calls.shared[0].key, "over9k.recovery");
  assert.ok(host.calls.run.length > 0);
  assert.equal(host.calls.shared.at(-1).key, "over9k.hiddenRemovals");
  const event = host.state.shared["over9k.hiddenRemovals"][0];
  assert.ok(event.targets.some((target) => target.address === "remote/music-child"));
  assert.equal(event.group, null);
  assert.ok(!JSON.stringify(event).includes("argv"));
});

test("pending removal identity participates in close confirmation identity", () => {
  const data = hiddenFixture();
  const before = buildClosePlan({ hidden: { kind: "agent", address: "remote/music-root", created_ms: 20 } }, data);
  data.hiddenRemovals = [{ id: "pending-1", targets: [{ address: "remote/other", created_ms: 1 }], recordKeys: [], group: null }];
  const after = buildClosePlan({ hidden: { kind: "agent", address: "remote/music-root", created_ms: 20 } }, data);
  assert.notEqual(closePlanIdentity(before), closePlanIdentity(after));
});
