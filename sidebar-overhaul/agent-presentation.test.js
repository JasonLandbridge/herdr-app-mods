import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPresentationAction,
  effectiveAgent,
  emptyPresentationState,
  normalizePresentationState,
  observePresentation,
  startPresentationSession,
} from "./agent-presentation.js";

const raw = (address, status, seq, extra = {}) => ({ address, status, seq, ...extra });
const term = (address, parent = null, extra = {}) => ({ address, parent, state: "live", ...extra });
const observe = (state, agents, terminals = [], machines = []) => observePresentation(state, agents, terminals, machines);
const click = (address, status, seq) => ({ type: "overview-agent-click", address, status, seq });

function statuses(state) {
  return Object.fromEntries(Object.entries(state.effective).map(([address, info]) => [address, info.status]));
}

test("initial working, idle, and done observations keep native categories and classify startup idle as inactive", () => {
  let state = observe(startPresentationSession(emptyPresentationState()), [
    raw("a-working", "working", 30),
    raw("a-idle", "idle", 20),
    raw("a-done", "done", 10),
  ], [term("a-working"), term("a-idle"), term("a-done")]);

  assert.deepEqual(statuses(state), { "a-working": "working", "a-idle": "inactive", "a-done": "done" });
  assert.equal(state.activity["a-working"], true);
  assert.equal(state.activity["a-idle"], undefined);
  assert.equal(state.activity["a-done"], undefined);
  assert.equal(state.raw["a-done"].status, "done");
});

test("Done click is captured before acknowledgement and holds its original sequence without mutating raw idle", () => {
  let state = observe(startPresentationSession(), [raw("a", "done", 44)], [term("a")]);
  state = applyPresentationAction(state, click("a", "done", 44));
  const before = raw("a", "idle", 91);
  state = observe(state, [before], [term("a")]);

  assert.equal(state.raw.a.status, "idle");
  assert.equal(state.raw.a.seq, 91);
  assert.deepEqual(state.held, { address: "a", seq: 44 });
  assert.equal(state.effective.a.status, "done");
  assert.equal(state.effective.a.seq, 44);
  assert.equal(before.status, "idle");
  assert.deepEqual(effectiveAgent(state, before), { ...before, status: "done", seq: 44 });
});

test("same held row is idempotent, a different Done transfers, and a non-Done selection releases to idle or inactive", () => {
  let state = observe(startPresentationSession(), [raw("a", "done", 4), raw("b", "done", 8), raw("c", "idle", 1)], [term("a"), term("b"), term("c")]);
  state = applyPresentationAction(state, click("a", "done", 4));
  state = applyPresentationAction(state, click("a", "idle", 999));
  assert.deepEqual(state.held, { address: "a", seq: 4 });

  state = applyPresentationAction(state, click("b", "done", 8));
  assert.deepEqual(state.held, { address: "b", seq: 8 });
  assert.equal(state.effective.a.status, "done");
  assert.equal(state.effective.b.status, "done");

  state = applyPresentationAction(state, click("c", "idle", 1));
  assert.equal(state.held, null);
  assert.equal(state.effective.b.status, "done");
  state = observe(state, [raw("a", "idle", 5), raw("b", "idle", 9), raw("c", "idle", 2)], [term("a"), term("b"), term("c")]);
  assert.deepEqual(statuses(state), { a: "inactive", b: "inactive", c: "inactive" });
});

test("new raw Working or Blocked clears only that agent's hold and no old hold resurrects", () => {
  let state = observe(startPresentationSession(), [raw("a", "done", 10), raw("b", "idle", 2)], [term("a"), term("b")]);
  state = applyPresentationAction(state, click("a", "done", 10));

  state = observe(state, [raw("a", "idle", 11), raw("b", "working", 12)], [term("a"), term("b")]);
  assert.deepEqual(state.held, { address: "a", seq: 10 });
  assert.equal(state.effective.a.status, "done");
  assert.equal(state.effective.b.status, "working");

  state = observe(state, [raw("a", "idle", 13), raw("b", "blocked", 14)], [term("a"), term("b")]);
  assert.deepEqual(state.held, { address: "a", seq: 10 });
  assert.equal(state.effective.a.status, "done");
  assert.equal(state.effective.b.status, "blocked");

  state = observe(state, [raw("a", "idle", 15), raw("b", "idle", 16)], [term("a"), term("b")]);
  assert.deepEqual(state.held, { address: "a", seq: 10 });
  assert.equal(state.effective.a.status, "done");

  state = observe(state, [raw("a", "blocked", 17), raw("b", "idle", 18)], [term("a"), term("b")]);
  assert.equal(state.held, null);
  assert.equal(state.effective.a.status, "blocked");

  state = observe(state, [raw("a", "idle", 19), raw("b", "idle", 20)], [term("a"), term("b")]);
  assert.equal(state.held, null);
  assert.equal(state.effective.a.status, "idle");

  state = observe(state, [raw("a", "done", 21), raw("b", "idle", 22)], [term("a"), term("b")]);
  state = applyPresentationAction(state, click("a", "done", 21));
  state = observe(state, [raw("a", "working", 23), raw("b", "idle", 24)], [term("a"), term("b")]);
  assert.equal(state.held, null);
  assert.equal(state.effective.a.status, "working");
  state = observe(state, [raw("a", "idle", 25), raw("b", "idle", 26)], [term("a"), term("b")]);
  assert.equal(state.held, null);
  assert.equal(state.effective.a.status, "idle");
});

test("focus, title, output, and sequence-only changes do not count as observed work", () => {
  let state = observe(startPresentationSession(), [raw("a", "idle", 1, { title: "first", focused: true })], [term("a")]);
  state = observe(state, [raw("a", "idle", 2, { title: "changed", output: "reply", focused: false })], [term("a")]);
  assert.equal(state.activity.a, undefined);
  assert.equal(state.effective.a.status, "inactive");
  assert.equal(state.effective.a.seq, 2);

  state = observe(state, [raw("a", "done", 3)], [term("a")]);
  assert.equal(state.activity.a, undefined);
  assert.equal(state.effective.a.status, "done");
});

test("non-overview selections are ignored by the production reducer", () => {
  const state = applyPresentationAction(
    observe(startPresentationSession(), [raw("a", "done", 4)], [term("a")]),
    { type: "agent.focus", address: "a", status: "done", seq: 4 },
  );
  assert.equal(state.held, null);
  assert.equal(state.effective.a.status, "done");
});

test("hidden agents remain in the observation set and descendant Working activates parents without changing parent raw status", () => {
  const parent = raw("parent", "idle", 20);
  const child = term("child", "parent", { program: { agent: true }, status: "working" });
  const agents = [parent];
  const terminals = [term("parent"), child];
  let state = observe(startPresentationSession(), agents, terminals);

  assert.equal(state.raw.parent.status, "idle");
  assert.equal(state.raw.child.status, "working");
  assert.equal(state.activity.parent, true);
  assert.equal(state.activity.child, true);
  assert.equal(state.effective.parent.status, "idle");
  assert.equal(state.effective.child.status, "working");
  assert.equal(agents[0].status, "idle");
  assert.equal(child.status, "working");
});

test("session reset clears activity and held Done state while preserving no retrospective history", () => {
  let state = observe(startPresentationSession(), [raw("a", "working", 1)], [term("a")]);
  state = applyPresentationAction(state, click("a", "done", 1));
  assert.equal(state.activity.a, true);
  assert.deepEqual(state.held, { address: "a", seq: 1 });

  const reset = startPresentationSession(state);
  assert.deepEqual(reset, normalizePresentationState(emptyPresentationState()));
});

test("ended local agents are cleaned up while remote absence remains available for reconnection", () => {
  let state = observe(startPresentationSession(), [raw("local", "working", 1), raw("workbox/remote", "working", 2)], [term("local"), term("workbox/remote")]);
  state = observe(state, [], [term("local", null, { state: "exited" })], [{ name: null, layout: "ready" }, { name: "workbox", layout: "unavailable" }]);
  assert.equal(state.activity.local, undefined);
  assert.equal(state.activity["workbox/remote"], true);
});

test("presentation observes unlabeled status-reporting terminals", () => {
  const state = observe(startPresentationSession(), [], [{ address: "unraid-dev/t-helper", state: "live", agent: "helper", status: "working", report: { seq: 9 } }]);
  assert.equal(state.raw["unraid-dev/t-helper"].status, "working");
  assert.equal(state.effective["unraid-dev/t-helper"].status, "working");
});
