import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RENDER_DIAGNOSTICS_HISTORY_KEY,
  RENDER_DIAGNOSTICS_KEY,
  RENDER_DIAGNOSTIC_STAGES,
  createRenderDiagnostics,
} from "./render-diagnostics.js";

class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]));
    this.reads = [];
    this.writes = [];
  }

  getItem(key) {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    const serialized = String(value);
    this.writes.push({ key, value: serialized });
    this.values.set(key, serialized);
  }

  read(key) {
    const value = this.values.get(key);
    return value == null ? null : JSON.parse(value);
  }
}

test("render diagnostics persist bounded stage breadcrumbs and elapsed timings", () => {
  const storage = new MemoryStorage();
  let now = 1000;
  const diagnostics = createRenderDiagnostics({ storage, now: () => now });
  const attempt = diagnostics.begin("expanded");

  assert.equal(storage.read(RENDER_DIAGNOSTICS_KEY).current.status, "running");
  assert.equal(storage.read(RENDER_DIAGNOSTICS_KEY).current.mode, "expanded");
  now = 1005;
  attempt.stage("native-snapshot", { spaces: 2, panes: 3 });
  now = 1015;
  attempt.stage("grouping", { spaces: 2, groups: 4 });
  now = 1025;
  attempt.complete({ rows: 5 });

  const state = storage.read(RENDER_DIAGNOSTICS_KEY);
  assert.equal(state.version, 2);
  assert.equal(state.current.status, "success");
  assert.equal(state.current.startedAt, 1000);
  assert.equal(state.current.elapsedMs, 25);
  assert.deepEqual(state.current.stages.map(({ name, startedAt, elapsedMs }) => ({ name, startedAt, elapsedMs })), [
    { name: "native-snapshot", startedAt: 1005, elapsedMs: 10 },
    { name: "grouping", startedAt: 1015, elapsedMs: 10 },
  ]);
  assert.deepEqual(state.current.counts, { rows: 5 });
  assert.deepEqual(RENDER_DIAGNOSTIC_STAGES, [
    "native-snapshot",
    "grouping",
    "recovery-capture-persist",
    "visual-publication",
    "hidden-removal",
    "visibility-reduce",
    "list-build",
    "final-tree-order",
  ]);
  assert.equal(storage.read(RENDER_DIAGNOSTICS_HISTORY_KEY), null);
});

test("a running attempt becomes incomplete on the next begin and history stays bounded", () => {
  const storage = new MemoryStorage();
  let now = 2000;
  const diagnostics = createRenderDiagnostics({ storage, now: () => now });
  const interrupted = diagnostics.begin("collapsed");
  interrupted.stage("native-snapshot", { spaces: 1 });
  now = 2010;
  diagnostics.begin("expanded");

  let history = storage.read(RENDER_DIAGNOSTICS_HISTORY_KEY);
  assert.equal(history.failures[0].status, "incomplete");
  assert.equal(history.failures[0].lastStage, "native-snapshot");
  assert.equal(history.failures[0].detectedAt, 2010);
  assert.equal("timeout" in history.failures[0], false);

  for (let i = 0; i < 10; i++) {
    const attempt = diagnostics.begin("expanded");
    attempt.fail(new Error(`failure ${i}`));
    now += 1;
  }
  const completed = diagnostics.begin("expanded");
  completed.complete();
  history = storage.read(RENDER_DIAGNOSTICS_HISTORY_KEY);
  assert.equal(storage.read(RENDER_DIAGNOSTICS_KEY).current.status, "success");
  assert.equal(history.version, 2);
  assert.equal(history.failures.length, 8);
  assert.ok(history.failures.every((attempt) => attempt.status === "failure"));
});

test("diagnostics storage failures never escape the render path", () => {
  const storage = {
    getItem() { throw new Error("read failed"); },
    setItem() { throw new Error("write failed"); },
  };
  const diagnostics = createRenderDiagnostics({ storage, now: () => 1 });
  const attempt = diagnostics.begin("expanded");
  assert.doesNotThrow(() => {
    attempt.stage("native-snapshot", { spaces: 1 });
    attempt.fail(new Error("failure"));
  });
});

test("error evidence is bounded and removes paths and URLs", () => {
  const storage = new MemoryStorage();
  const diagnostics = createRenderDiagnostics({ storage, now: () => 1 });
  const attempt = diagnostics.begin("expanded");
  const error = new Error(`bad /tmp/${"x".repeat(1000)} https://example.test/private`);
  error.stack = `Error: /tmp/private.jsonl\n    at /home/dev/main.js:12:4`;
  attempt.fail(error);

  const logged = storage.read(RENDER_DIAGNOSTICS_KEY).current.error;
  assert.equal(logged.message, "bad <path> <url>");
  assert.ok(logged.message.length <= 512);
  assert.equal(logged.stack, "Error: private.jsonl\n    at main.js:12:4");
  assert.ok(logged.stack.length <= 2048);
});

test("populated failure history is not rewritten by a successful render", () => {
  const history = {
    version: 2,
    failures: [{
      status: "failure",
      mode: "expanded",
      startedAt: 1,
      endedAt: 2,
      elapsedMs: 1,
      stages: [{ name: "grouping", startedAt: 1, elapsedMs: 1, counts: { groups: 2 } }],
      lastStage: "grouping",
      counts: { groups: 2 },
      error: { name: "Error", message: "old failure" },
    }],
  };
  const storage = new MemoryStorage({
    [RENDER_DIAGNOSTICS_KEY]: { version: 2, current: null },
    [RENDER_DIAGNOSTICS_HISTORY_KEY]: history,
  });
  const diagnostics = createRenderDiagnostics({ storage, now: () => 100 });
  const historyBefore = storage.values.get(RENDER_DIAGNOSTICS_HISTORY_KEY);
  const historyWritesBefore = storage.writes.filter(({ key }) => key === RENDER_DIAGNOSTICS_HISTORY_KEY).length;

  const attempt = diagnostics.begin("expanded");
  attempt.stage("native-snapshot", { spaces: 2 });
  attempt.complete({ rows: 3 });

  assert.equal(storage.values.get(RENDER_DIAGNOSTICS_HISTORY_KEY), historyBefore);
  assert.equal(
    storage.writes.filter(({ key }) => key === RENDER_DIAGNOSTICS_HISTORY_KEY).length,
    historyWritesBefore,
  );
  assert.deepEqual(Object.keys(storage.read(RENDER_DIAGNOSTICS_KEY)), ["version", "current"]);
});

test("reloading the controller retains archived history", () => {
  const storage = new MemoryStorage();
  let now = 1;
  const first = createRenderDiagnostics({ storage, now: () => now });
  first.begin("expanded").fail(new Error("first failure"));
  now = 2;
  first.begin("expanded").complete();
  const archived = storage.read(RENDER_DIAGNOSTICS_HISTORY_KEY);
  const writesBeforeReloadedRender = storage.writes.length;

  const reloaded = createRenderDiagnostics({ storage, now: () => now });
  reloaded.begin("expanded").fail(new Error("second failure"));
  now = 3;
  reloaded.begin("expanded").complete();

  const history = storage.read(RENDER_DIAGNOSTICS_HISTORY_KEY);
  assert.equal(history.failures.length, 2);
  assert.equal(history.failures[1].error.message, archived.failures[0].error.message);
  assert.ok(storage.writes.length > writesBeforeReloadedRender);
});

test("v1 inline failures migrate to the history key without losing evidence", () => {
  const inlineFailure = {
    status: "failure",
    mode: "expanded",
    startedAt: 10,
    endedAt: 20,
    elapsedMs: 10,
    lastStage: "grouping",
    stages: [{ name: "grouping", startedAt: 10, elapsedMs: 10, counts: { groups: 4 } }],
    counts: { groups: 4 },
    error: { name: "Error", message: "kept failure", stack: "Error: kept failure" },
  };
  const previousHistory = {
    version: 2,
    failures: [{
      status: "incomplete",
      mode: "collapsed",
      startedAt: 5,
      detectedAt: 6,
      stages: [],
      counts: {},
    }],
  };
  const storage = new MemoryStorage({
    [RENDER_DIAGNOSTICS_KEY]: {
      version: 1,
      current: { status: "success", mode: "expanded", startedAt: 30, stages: [], counts: {} },
      failures: [inlineFailure],
    },
    [RENDER_DIAGNOSTICS_HISTORY_KEY]: previousHistory,
  });

  createRenderDiagnostics({ storage, now: () => 100 });

  assert.deepEqual(storage.read(RENDER_DIAGNOSTICS_KEY), {
    version: 2,
    current: { status: "success", mode: "expanded", startedAt: 30, stages: [], counts: {} },
  });
  const migrated = storage.read(RENDER_DIAGNOSTICS_HISTORY_KEY);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.failures.length, 2);
  assert.deepEqual(migrated.failures[0].error, inlineFailure.error);
  assert.deepEqual(migrated.failures[0].stages[0], inlineFailure.stages[0]);
  assert.deepEqual(migrated.failures[1], previousHistory.failures[0]);
});
