import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OMP_HEADER_LINES,
  parseSessionHeader,
} from "./session-metadata.js";
import {
  RecoveryController,
  findLiveVerified,
  liveOmpSessions,
  recoveryRecords,
  scopedRecoveryRecord,
  selectedRecoveryRecord,
} from "./recovery-controller.js";

const path = "/srv/omp/sessions/session-1.jsonl";
const cwd = "/srv/workspaces/app";
const header = (id = "session-1", folder = cwd) => [
  JSON.stringify({ type: "title", v: 1, title: "Repair auth" }),
  JSON.stringify({ type: "session", version: 3, id, cwd: folder }),
  JSON.stringify({ type: "model_change", modelId: "local" }),
  JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }),
  JSON.stringify({ type: "message", message: { role: "user", content: "must not be read" } }),
].join("\n");

function mockHost({ files = {}, spaces = [], panes = [], terminals = [], agents = [], find = "", remoteHome = null, remoteHomeCode = 0, visibilityActions = [] } = {}) {
  const calls = { exec: [], run: [], shared: [] };
  let queuedVisibility = visibilityActions;
  const host = {
    calls,
    spaces: () => spaces,
    panes: () => panes,
    terminals: () => terminals,
    agents: () => agents,
    shared: (key) => key === "herdr-custom.agentVisibility.actions" ? queuedVisibility : undefined,
    setShared: (key, value) => {
      if (key === "herdr-custom.agentVisibility.actions") queuedVisibility = value;
      calls.shared.push({ key, value });
    },
    run: (name, args) => calls.run.push({ name, args }),
    exec: async (program, args, options) => {
      calls.exec.push({ program, args, options });
      if (program === "printenv") return remoteHomeCode === 0 ? { code: 0, stdout: remoteHome ?? "" } : { code: remoteHomeCode, stderr: "remote home unavailable" };
      if (program === "find") return { code: 0, stdout: find };
      const exact = args.at(-1);
      if (program === "head" && Object.hasOwn(files, exact)) return { code: 0, stdout: files[exact] };
      return { code: 1, stderr: "not reachable" };
    },
  };
  return host;
}

const verified = (overrides = {}) => ({
  key: "saved-1",
  machine: "builder",
  address: "builder/old-terminal",
  created_ms: 10,
  title: "Repair auth",
  app: "omp",
  cwd,
  owner: { id: "builder/space", name: "app", folder: cwd },
  visual: { key: "project:app", label: "app", folder: cwd, machine: "builder", kind: "project" },
  sessionId: "session-1",
  sessionPath: path,
  verified: true,
  ...overrides,
});

const unknown = (overrides = {}) => verified({ verified: false, ...overrides });

test("valid verified OMP restore uses the saved machine, folder and exact argv", async () => {
  const host = mockHost({ files: { [path]: header() } });
  const result = await new RecoveryController(host).restore(verified());
  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.run, [{
    name: "space.new",
    args: { machine: "builder", folder: cwd, argv: ["omp", "--restore", path] },
  }]);
  assert.deepEqual(host.calls.exec[0], { program: "head", args: ["-n", String(OMP_HEADER_LINES), path], options: { on: "builder" } });
});

test("unverified records issue no command until one explicit validated selection is confirmed", async () => {
  const host = mockHost({ files: { [path]: header() }, find: `${path}\n` });
  const controller = new RecoveryController(host);
  const before = await controller.restore(unknown());
  assert.equal(before.ok, false);
  assert.deepEqual(host.calls.run, []);
  const discovered = await controller.discover({ root: "/srv/omp/sessions", machine: "builder", cwd });
  assert.equal(discovered.candidates.length, 1);
  assert.deepEqual(host.calls.run, []);
  const selected = await controller.restore(unknown(), { path: discovered.candidates[0].path, confirm: true });
  assert.equal(selected.ok, true);
  assert.equal(host.calls.run[0].name, "space.new");
});

test("scoped group recovery uses explicit machine and cwd without fabricating a saved record", async () => {
  const record = scopedRecoveryRecord({ machine: "builder", folder: cwd, label: "legacy app" });
  assert.equal(recoveryRecords({ records: {} }).length, 0);
  assert.equal(record.key, null);
  assert.equal(record.ephemeral, true);
  assert.equal(record.title, "Group recovery · legacy app");
  const selectedGroup = selectedRecoveryRecord([], null, { machine: "builder", folder: cwd, label: "legacy app" });
  assert.equal(selectedGroup.ephemeral, true);
  assert.equal(selectedGroup.machine, "builder");
  assert.equal(selectedGroup.cwd, cwd);
  assert.equal(selectedRecoveryRecord([], null, {}), null);
  const host = mockHost({ files: { [path]: header() }, find: `${path}\n` });
  const controller = new RecoveryController(host);
  const discovered = await controller.discover({ root: "/srv/omp/sessions", machine: record.machine, cwd: record.cwd });
  assert.equal(discovered.ok, true);
  assert.deepEqual(host.calls.run, []);
  assert.deepEqual(discovered.candidates.map((candidate) => candidate.path), [path]);
  const selected = discovered.candidates[0];
  const result = await controller.restore(record, {
    path: selected.path,
    confirm: true,
    machine: record.machine,
    folder: record.cwd,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.run, [{
    name: "space.new",
    args: { machine: "builder", folder: cwd, argv: ["omp", "--restore", path] },
  }]);
});

test("wrong type, identity, cwd and unreachable headers are rejected without launch", async () => {
  const cases = [
    ["wrong type", JSON.stringify({ type: "message", message: "not a session" })],
    ["wrong identity", header("other")],
    ["wrong cwd", header("session-1", "/srv/workspaces/other")],
  ];
  for (const [name, contents] of cases) {
    const host = mockHost({ files: { [path]: contents } });
    const result = await new RecoveryController(host).restore(verified());
    assert.equal(result.ok, false, name);
    assert.deepEqual(host.calls.run, [], name);
  }
  const unreachable = new RecoveryController(mockHost()).restore(verified());
  assert.equal((await unreachable).ok, false, "unreachable");
});

test("header parsing is bounded to metadata lines and never consumes a message", () => {
  const parsed = parseSessionHeader(header());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, "session-1");
  assert.equal(parsed.cwd, cwd);
  assert.equal(parsed.title, "Repair auth");
});

test("verified live remap focuses the exact session at a new terminal address without duplication", async () => {
  const liveAddress = "builder/new-terminal";
  const host = mockHost({
    files: { [path]: header() },
    terminals: [{ address: liveAddress, foreground: { argv: ["omp", "--restore", path] }, labels: { "revive.session": "session-1" } }],
    agents: [{ address: liveAddress, app: "omp" }],
    panes: [{ pane: "pane-1", tab: "tab-1", terminal: liveAddress, cwd }],
    spaces: [{ id: "space-1", machine: "builder", folder: cwd, active: false, tabs: [{ id: "tab-1" }] }],
  });
  const controller = new RecoveryController(host);
  const result = await controller.restore(verified({ address: "builder/old-terminal", created_ms: 1 }));
  assert.equal(result.ok, true);
  assert.equal(result.focused, true);
  assert.deepEqual(host.calls.run, [
    { name: "space.select", args: { id: "space-1" } },
    { name: "tab.select", args: { id: "tab-1" } },
    { name: "pane.focus", args: { pane: "pane-1" } },
  ]);
  assert.equal(host.calls.run.some((command) => command.name === "space.new" || command.name === "tab.new"), false);
});
test("live recovery queues reveal for the remapped terminal and its hidden parent before focus", async () => {
  const liveAddress = "builder/new-terminal";
  const host = mockHost({
    files: { [path]: header() },
    terminals: [{ address: liveAddress, parent: "builder/parent", created_ms: 42, foreground: { argv: ["omp", "--restore", path] } }, { address: "builder/parent", created_ms: 41 }],
    agents: [{ address: liveAddress, app: "omp" }],
    panes: [{ pane: "pane-1", tab: "tab-1", terminal: liveAddress, cwd }],
    spaces: [{ id: "space-1", machine: "builder", folder: cwd, active: true, tabs: [{ id: "tab-1" }] }],
  });
  const result = await new RecoveryController(host).restore(verified({ address: "builder/old-terminal" }));
  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.shared[0], {
    key: "herdr-custom.agentVisibility.actions",
    value: [{ type: "reveal", addresses: [liveAddress, "builder/parent"], entries: {
      [liveAddress]: { created_ms: 42, recordKey: "saved-1" },
      "builder/parent": { created_ms: 41 },
    } }],
  });
  assert.equal(host.calls.run[0].name, "tab.select");
});

test("nonlive recovery queues a pending reveal before opening one exact restore space", async () => {
  const host = mockHost({ files: { [path]: header() } });
  const result = await new RecoveryController(host).restore(verified({ address: "builder/saved-terminal" }));
  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.shared[0], {
    key: "herdr-custom.agentVisibility.actions",
    value: [{ type: "reveal-launch", machine: "builder", folder: cwd, recordKey: "saved-1", before: [] }],
  });
  assert.deepEqual(host.calls.run, [{ name: "space.new", args: { machine: "builder", folder: cwd, argv: ["omp", "--restore", path] } }]);
});

test("Claude and Codex records are explicitly unsupported and never inspected or launched as OMP", async () => {
  for (const app of ["claude-code", "codex"]) {
    const host = mockHost({ files: { [path]: header() } });
    const result = await new RecoveryController(host).restore(verified({ app }));
    assert.equal(result.ok, false);
    assert.match(result.error, /unsupported/i);
    assert.deepEqual(host.calls.exec, []);
    assert.deepEqual(host.calls.run, []);
  }
});

test("legacy state records remain listed without inventing a newest selection", () => {
  const records = recoveryRecords({ records: {
    old: { key: "old", machine: "builder", address: "builder/t1", cwd, app: "omp", verified: false },
    newer: { key: "newer", machine: "builder", address: "builder/t2", cwd, app: "omp", verified: false, lastSeen: 999 },
  } });
  assert.deepEqual(records.map((record) => record.key), ["old", "newer"]);
});

test("live metadata honors the current foreground and rejects a stale shell wrapper", () => {
  const frame = {
    terminals: [{ address: "builder/t1", foreground: { argv: ["sh", "-lc", "omp --restore /wrong.jsonl"] }, labels: { "revive.session": "session-1" } }],
    agents: [{ address: "builder/t1", foreground: { argv: ["omp", "--restore", path] } }],
    panes: [],
    spaces: [],
  };
  assert.deepEqual(liveOmpSessions(frame), []);
  assert.equal(findLiveVerified(verified(), []), null);
});

test("current restore path does not inherit stale Revive id or cwd labels", () => {
  const address = "builder/t1";
  const live = liveOmpSessions({
    terminals: [{
      address,
      cwd: "/runtime",
      foreground: { argv: ["omp", "--restore", path] },
      labels: { "revive.transcript": "/stale/session.jsonl", "revive.session": "stale", "revive.cwd": "/stale" },
    }],
    agents: [{ address, app: "omp" }],
    panes: [],
    spaces: [],
  })[0];
  assert.equal(live.sessionPath, path);
  assert.equal(live.sessionId, null);
  assert.equal(live.cwd, "/runtime");
  assert.ok(findLiveVerified(verified(), [live]));
});

test("numeric TabInfo pane counts use agent ownership for live focus", async () => {
  const liveAddress = "builder/new-terminal";
  const host = mockHost({
    files: { [path]: header() },
    terminals: [{ address: liveAddress, foreground: { argv: ["omp", "--restore", path] } }],
    agents: [{ address: liveAddress, app: "omp", space: "space-1", tab: "tab-1" }],
    panes: [],
    spaces: [{
      id: "space-1",
      machine: "builder",
      folder: cwd,
      active: false,
      tabs: [{ id: "tab-1", panes: 1 }],
    }],
  });
  const result = await new RecoveryController(host).restore(verified());
  assert.equal(result.ok, true);
  assert.equal(result.focused, true);
  assert.deepEqual(host.calls.run, [
    { name: "space.select", args: { id: "space-1" } },
    { name: "tab.select", args: { id: "tab-1" } },
    { name: "agent.focus", args: { terminal: liveAddress } },
  ]);
});

test("matching native space gets a tab instead of a duplicate space", async () => {
  const host = mockHost({
    files: { [path]: header() },
    spaces: [{ id: "space-1", machine: "builder", folder: cwd, active: true, tabs: [] }],
  });
  const result = await new RecoveryController(host).restore(verified());
  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.run, [{
    name: "tab.new",
    args: { space: "space-1", folder: cwd, argv: ["omp", "--restore", path] },
  }]);
});

test("remote OMP discovery resolves HOME with a direct command and preserves machine scope", async () => {
  const host = mockHost({ remoteHome: "/remote/home" });
  const root = await new RecoveryController(host).remoteSessionRoot("builder");
  assert.equal(root, "/remote/home/.omp/agent/sessions");
  assert.deepEqual(host.calls.exec, [{ program: "printenv", args: ["HOME"], options: { on: "builder" } }]);
  assert.deepEqual(host.calls.run, []);
});

test("remote HOME discovery failure is visible to the caller and is not retried", async () => {
  const host = mockHost({ remoteHomeCode: 1 });
  const root = await new RecoveryController(host).remoteSessionRoot("builder");
  assert.equal(root, null);
  assert.equal(host.calls.exec.length, 1);
  assert.deepEqual(host.calls.run, []);
});
test("group recovery restores each exact verified session once and preserves failures", async () => {
  const secondPath = "/srv/omp/sessions/session-2.jsonl";
  const first = verified();
  const second = verified({ key: "saved-2", sessionPath: secondPath, sessionId: "session-2" });
  const host = mockHost({ files: { [path]: header(), [secondPath]: header("session-2") }, spaces: [{ id: "builder/space", machine: "builder", folder: cwd, active: true }] });
  const result = await new RecoveryController(host).restoreGroup([first, first, second, verified({ key: "unverified", verified: false, sessionPath: "/missing.jsonl" })]);
  assert.equal(result.ok, false);
  assert.deepEqual(host.calls.run, [first, second].map(record => ({ name: "tab.new", args: { space: "builder/space", folder: cwd, argv: ["omp", "--restore", record.sessionPath] } })));
  assert.deepEqual(result.results.map(item => [item.key, item.ok]), [[first.key, true], [second.key, true], ["unverified", false]]);
});
