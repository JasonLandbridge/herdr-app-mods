import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RECOVERY_STATE,
  REVIVE_LABELS,
  captureRecoveryRecord,
  captureRecoveryRecords,
  emptyRecoveryState,
  findVerifiedRecoveryRecord,
  mergeRecoveryState,
  normalizeRecoveryState,
  remapVerifiedRecovery,
  sessionMetadata,
  stableRecoveryKey,
} from "./recovery-state.js";

const owner = { id: "sp-home", name: "~", folder: "/home/dev" };
const visual = { key: "r:unraid-dev:/workspaces/MusicBumble", label: "MusicBumble", folder: "/workspaces/MusicBumble", machine: "unraid-dev", kind: "project" };

const revive = (path = "/home/dev/.omp/session.jsonl") => ({
  labels: {
    [REVIVE_LABELS.agent]: "claude",
    [REVIVE_LABELS.session]: "session-1",
    [REVIVE_LABELS.transcript]: path,
    [REVIVE_LABELS.cwd]: "/workspaces/MusicBumble",
  },
});

test("current restore path wins over conflicting stale Revive labels", () => {
  const term = {
    cwd: "/current",
    foreground: { argv: ["omp", "--restore", "/current.jsonl"] },
    labels: {
      [REVIVE_LABELS.session]: "stale-session",
      [REVIVE_LABELS.transcript]: "/stale.jsonl",
      [REVIVE_LABELS.cwd]: "/stale",
    },
  };
  assert.deepEqual(sessionMetadata(term), {
    sessionId: null,
    sessionPath: "/current.jsonl",
    verified: true,
    cwd: "/current",
  });
});

test("known shell foreground invalidates old Revive identity labels", () => {
  const info = sessionMetadata({
    cwd: "/current",
    foreground: { argv: ["zsh"] },
    labels: {
      [REVIVE_LABELS.session]: "stale-session",
      [REVIVE_LABELS.transcript]: "/stale.jsonl",
      [REVIVE_LABELS.cwd]: "/stale",
    },
  });
  assert.deepEqual(info, { sessionId: null, sessionPath: null, verified: false, cwd: "/current" });
});

test("recovery state key and registry survive an empty restart frame", () => {
  const term = { address: "unraid-dev/t3", created_ms: 100, ...revive() };
  const record = captureRecoveryRecord({ machine: "unraid-dev", terminal: term, agent: { address: term.address, title: "Music work", app: "claude-code" }, owner, visual, lastSeen: 200 });
  const state = mergeRecoveryState(emptyRecoveryState(), [record]);
  const restarted = normalizeRecoveryState(state);
  assert.equal(RECOVERY_STATE, "over9k.recovery");
  assert.equal(record.key, JSON.stringify(["unraid-dev", "session", "/home/dev/.omp/session.jsonl"]));
  assert.deepEqual(Object.keys(restarted.records), [record.key]);
  assert.equal(restarted.records[record.key].visual.key, visual.key);
});

test("missing frames retain records and unchanged snapshots keep their timestamp", () => {
  const record = captureRecoveryRecord({
    machine: "unraid-dev",
    terminal: { address: "unraid-dev/t3", created_ms: 100, ...revive() },
    owner,
    visual,
    lastSeen: 200,
  });
  const state = mergeRecoveryState(emptyRecoveryState(), [record]);
  const retained = mergeRecoveryState(state, captureRecoveryRecords({ terms: [], ps: [], ag: [] }, 999));
  assert.deepEqual(Object.keys(retained.records), [record.key]);
  assert.equal(retained.records[record.key].lastSeen, 200);

  const unchanged = mergeRecoveryState(retained, [{ ...record, lastSeen: 300 }]);
  assert.equal(unchanged.records[record.key].lastSeen, 200);
  const lifecycleChanged = mergeRecoveryState(unchanged, [{ ...record, address: "unraid-dev/t9", created_ms: 101, lastSeen: 400 }]);
  assert.equal(lifecycleChanged.records[record.key].lastSeen, 400);
});

test("address-only enrichment requires the same known terminal incarnation", () => {
  const unknown = captureRecoveryRecord({
    machine: "unraid-dev",
    terminal: { address: "unraid-dev/t3", created_ms: 100, cwd: "/workspaces/MusicBumble" },
    owner,
    visual,
    lastSeen: 100,
  });
  const reincarnated = captureRecoveryRecord({
    machine: "unraid-dev",
    terminal: { address: "unraid-dev/t3", created_ms: 101, ...revive() },
    owner,
    visual,
    lastSeen: 101,
  });
  const state = mergeRecoveryState(emptyRecoveryState(), [unknown, reincarnated]);
  assert.equal(Object.keys(state.records).length, 2);
  assert.ok(state.records[unknown.key]);
  assert.ok(state.records[reincarnated.key]);

  const enriched = captureRecoveryRecord({
    machine: "unraid-dev",
    terminal: { address: "unraid-dev/t3", created_ms: 100, ...revive() },
    owner,
    visual,
    lastSeen: 102,
  });
  const merged = mergeRecoveryState(emptyRecoveryState(), [unknown, enriched]);
  assert.equal(Object.keys(merged.records).length, 1);
  assert.equal(merged.records[enriched.key].verified, true);
  assert.equal(merged.records[enriched.key].lastSeen, 102);
  assert.equal(merged.records[unknown.key], undefined);
});

test("unknown sessions use terminal incarnation and never cwd remapping", () => {
  const a = stableRecoveryKey({ machine: "workbox", address: "workbox/t1", terminalCreatedMs: 10 });
  const b = stableRecoveryKey({ machine: "workbox", address: "workbox/t1", terminalCreatedMs: 11 });
  assert.notEqual(a, b);
  const first = captureRecoveryRecord({ machine: "workbox", terminal: { address: "workbox/t1", created_ms: 10, cwd: "/repo/a" }, owner: { id: "s1", folder: "/repo/a" }, lastSeen: 10 });
  const replacement = captureRecoveryRecord({ machine: "workbox", terminal: { address: "workbox/t1", created_ms: 11, cwd: "/repo/a" }, owner: { id: "s2", folder: "/repo/a" }, lastSeen: 11 });
  const state = mergeRecoveryState(emptyRecoveryState(), [first, replacement]);
  assert.equal(Object.keys(state.records).length, 2);
});

test("restore/resume argv provides verified exact path even without Revive labels", () => {
  const term = { address: "unraid-dev/t3", foreground: { argv: ["omp", "--restore", "/home/dev/.omp/session.jsonl"] } };
  const info = sessionMetadata(term);
  assert.equal(info.sessionPath, "/home/dev/.omp/session.jsonl");
  assert.equal(info.verified, true);
  const record = captureRecoveryRecord({ machine: "unraid-dev", terminal: term, owner, visual });
  assert.equal(record.verified, true);
  assert.equal(record.key, JSON.stringify(["unraid-dev", "session", "/home/dev/.omp/session.jsonl"]));
});

test("capture records includes visual group and actual native owner", () => {
  const term = { address: "unraid-dev/t3", created_ms: 10, ...revive() };
  const records = captureRecoveryRecords({
    sp: [{ id: "unraid-dev/sp-home", name: "~", folder: "/home/dev", machine: "unraid-dev", tabs: [{ id: "unraid-dev/tab" }] }],
    ps: [{ pane: "p1", terminal: term.address, tab: "unraid-dev/tab", cwd: "/workspaces/MusicBumble" }],
    ag: [{ address: term.address, pane: "p1", title: "Music work", app: "claude-code" }],
    terms: [term],
    groups: new Map([[visual.key, [{ p: { pane: "p1", terminal: term.address }, visual }]]]),
    groupMeta: new Map([[visual.key, visual]]),
  }, 12);
  assert.equal(records.length, 1);
  assert.equal(records[0].owner.id, "unraid-dev/sp-home");
  assert.equal(records[0].visual.key, visual.key);
});

test("numeric tab pane counts do not break owner lookup for no-pane descendants", () => {
  const space = { id: "unraid-dev/sp-home", name: "~", folder: "/home/dev", machine: "unraid-dev", tabs: [{ id: "unraid-dev/tab", panes: 2 }] };
  const parent = "unraid-dev/t-parent";
  const child = "unraid-dev/t-child";
  const records = captureRecoveryRecords({
    sp: [space],
    ps: [{ pane: "p-parent", terminal: parent, tab: "unraid-dev/tab", cwd: "/workspaces/MusicBumble" }],
    ag: [
      { address: parent, pane: "p-parent", space: space.id, tab: "unraid-dev/tab", title: "Parent", app: "claude-code" },
      { address: child, title: "Child", app: "claude-code" },
    ],
    terms: [
      { address: parent, created_ms: 1, program: { agent: true } },
      { address: child, created_ms: 2, parent, program: { agent: true } },
    ],
  }, 12);
  assert.equal(records.find((record) => record.address === child).owner.id, space.id);
});

test("terminal space labels resolve owners when no pane is present", () => {
  const space = { id: "unraid-dev/sp-home", name: "~", folder: "/home/dev", machine: "unraid-dev", tabs: [{ id: "unraid-dev/tab", panes: 1 }] };
  const address = "unraid-dev/t-label";
  const records = captureRecoveryRecords({
    sp: [space],
    ag: [{ address, title: "Labeled", app: "claude-code" }],
    terms: [{ address, created_ms: 3, labels: { "herdr.space": space.id }, program: { agent: true } }],
  }, 13);
  assert.equal(records[0].owner.id, space.id);
});

test("verified remapping requires exact session identity and machine", () => {
  const record = captureRecoveryRecord({ machine: "unraid-dev", terminal: { address: "unraid-dev/t3", created_ms: 100, ...revive() }, owner, visual });
  const match = findVerifiedRecoveryRecord({ records: { [record.key]: record } }, [{ machine: "unraid-dev", terminal: { address: "unraid-dev/t9", created_ms: 999, ...revive() } }]);
  assert.equal(match.record.key, record.key);
  const wrongSessionId = { machine: "unraid-dev", terminal: { address: "unraid-dev/t11", created_ms: 1001, labels: { [REVIVE_LABELS.transcript]: record.sessionPath, [REVIVE_LABELS.session]: "other" } } };
  assert.equal(remapVerifiedRecovery({ records: { [record.key]: record } }, [wrongSessionId]).length, 0);
  const liveWithoutSessionId = { machine: "unraid-dev", terminal: { address: "unraid-dev/t10", created_ms: 1000, foreground: { argv: ["omp", "--restore", record.sessionPath] } } };
  assert.equal(remapVerifiedRecovery({ records: { [record.key]: record } }, [liveWithoutSessionId]).length, 1);
  assert.equal(remapVerifiedRecovery({ records: { [record.key]: record } }, [{ machine: "workbox", terminal: { address: "workbox/t9", created_ms: 999, ...revive() } }]).length, 0);
  assert.equal(remapVerifiedRecovery({ records: { [record.key]: record } }, [{ machine: "unraid-dev", terminal: { address: "unraid-dev/t9", created_ms: 999, cwd: "/other", labels: { [REVIVE_LABELS.transcript]: "/other.jsonl", [REVIVE_LABELS.session]: "other" } } }]).length, 0);
});

