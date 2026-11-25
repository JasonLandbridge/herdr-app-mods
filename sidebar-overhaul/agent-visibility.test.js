import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyVisibilityAction,
  effectiveVisibility,
  emptyVisibilityState,
  groupEffectiveVisibility,
  hiddenEntries,
  hiddenGroups,
  isExplicitlyHidden,
  isRevealed,
  normalizeVisibilityState,
  pruneEnded,
  startVisibilitySession,
  withEffective,
} from "./agent-visibility.js";

import { isAgentTerminal } from "./agent-classifier.js";
const agent = (address) => ({ address });
const term = (address, parent = null, state = "live") => ({ address, parent, state, program: { agent: true } });
const terminalAt = (address, parent, created_ms, state = "live") => ({ ...term(address, parent, state), created_ms });

test("project group hides current and future members through the production classifier", () => {
  const group = { key: "project:/repo", kind: "project", label: "repo", folder: "/repo", machine: null };
  let state = applyVisibilityAction(emptyVisibilityState(), { type: "hide-group", group });
  const terms = [term("t-parent"), term("t-shell"), term("t-other"), term("t-later")];
  const layout = { groups: {
    "t-parent": "project:/repo",
    "t-shell": "project:/repo",
    "t-other": "project:/other",
    "t-later": "project:/repo",
  } };
  const effective = groupEffectiveVisibility(state, terms.map(agent), terms, layout);
  assert.deepEqual(Object.keys(effective).sort(), ["t-later", "t-parent", "t-shell"]);
  assert.equal(effective["t-later"].group, group.key);
  assert.deepEqual(state.hidden, {});
  assert.deepEqual(hiddenGroups(state), [{ key: group.key, kind: group.kind, label: "repo", machine: null, folder: group.folder }]);
});

test("group-hidden ancestor stays hidden across projects while a moved root is visible", () => {
  const group = { key: "space:s1", kind: "space", label: "Work", machine: null, folder: "/repo" };
  const state = applyVisibilityAction(emptyVisibilityState(), { type: "hide-group", group });
  const terms = [term("t-parent"), term("t-child", "t-parent")];
  const split = groupEffectiveVisibility(state, terms.map(agent), terms, {
    groups: { "t-parent": "space:s1", "t-child": "space:s2" },
  });
  assert.equal(split["t-parent"].group, group.key);
  assert.equal(split["t-child"].inheritedFrom, "t-parent");
  const moved = groupEffectiveVisibility(state, terms.map(agent), terms, {
    groups: { "t-parent": "space:s2", "t-child": "space:s2" },
  });
  assert.deepEqual(moved, {});
});

test("hidden parents cover current and future children, while explicit child hides survive parent restore", () => {
  let state = applyVisibilityAction(emptyVisibilityState(), { type: "hide", address: "t-parent" });
  state = applyVisibilityAction(state, { type: "hide", address: "t-explicit-child" });
  const current = [term("t-parent"), term("t-explicit-child", "t-parent"), term("t-child", "t-parent")];
  const hidden = withEffective(state, current.map(agent), current);
  assert.equal(hidden.effective["t-child"].inheritedFrom, "t-parent");
  assert.equal(hidden.effective["t-explicit-child"].inheritedFrom, "t-parent");
  assert.equal(hiddenEntries(hidden, current.map(agent), current).find((x) => x.address === "t-child").canRestore, false);
  assert.equal(hiddenEntries(hidden, current.map(agent), current).find((x) => x.address === "t-explicit-child").canRestore, false);
  assert.deepEqual(["t-parent", "t-child", "t-explicit-child", "t-other"].filter((address) => !hidden.effective[address]), ["t-other"]);

  const future = [...current, term("t-future-child", "t-parent")];
  assert.equal(withEffective(state, future.map(agent), future).effective["t-future-child"].inheritedFrom, "t-parent");
  state = applyVisibilityAction(state, { type: "restore", address: "t-parent" });
  const restored = withEffective(state, future.map(agent), future);
  assert.equal(restored.effective["t-parent"], undefined);
  assert.equal(restored.effective["t-child"], undefined);
  assert.equal(restored.effective["t-future-child"], undefined);
  assert.equal(restored.effective["t-explicit-child"].explicit, true);
  assert.equal(restored.effective["t-explicit-child"].inheritedFrom, null);
  assert.equal(hiddenEntries(restored, future.map(agent), future).find((x) => x.address === "t-explicit-child").canRestore, true);
});

test("persistent selections round-trip while the hidden drawer resets closed on restart", () => {
  let state = applyVisibilityAction(emptyVisibilityState(), { type: "hide", address: "workbox/t-live" });
  state = applyVisibilityAction(state, { type: "hide-group", group: { key: "project:/repo", kind: "project", label: "repo", folder: "/repo", machine: null } });
  state.open = true;
  const roundTrip = normalizeVisibilityState(JSON.parse(JSON.stringify(state)));
  assert.equal(roundTrip.open, true);
  assert.deepEqual(roundTrip.hidden, { "workbox/t-live": {} });
  assert.equal(roundTrip.groups["project:/repo"].label, "repo");
  const restarted = startVisibilitySession(roundTrip);
  assert.equal(restarted.open, false);
  assert.deepEqual(restarted.hidden, roundTrip.hidden);
  assert.deepEqual(restarted.groups, roundTrip.groups);
});
test("revealing one hidden child persists across restart and keeps hidden siblings", () => {
  const terms = [term("t-parent"), term("t-child", "t-parent"), term("t-sibling", "t-parent")];
  let state = applyVisibilityAction(emptyVisibilityState(), { type: "hide", address: "t-parent" });
  state = applyVisibilityAction(state, { type: "reveal", addresses: ["t-child"] });
  const visible = withEffective(state, terms.map(agent), terms);
  assert.equal(visible.effective["t-child"], undefined);
  assert.equal(visible.effective["t-sibling"].inheritedFrom, "t-parent");
  const restarted = withEffective(startVisibilitySession(normalizeVisibilityState(JSON.parse(JSON.stringify(state)))), terms.map(agent), terms);
  assert.equal(restarted.effective["t-child"], undefined);
  assert.equal(restarted.effective["t-sibling"].inheritedFrom, "t-parent");
  assert.equal(isRevealed(restarted, "t-child", terms[1]), true);
});

test("revealing a blocked target leaves an explicit sibling hidden", () => {
  const terms = [term("t-parent"), term("t-child", "t-parent"), term("t-sibling", "t-parent")];
  let state = applyVisibilityAction(emptyVisibilityState(), { type: "hide", address: "t-parent" });
  state = applyVisibilityAction(state, { type: "hide", address: "t-sibling" });
  state = applyVisibilityAction(state, { type: "reveal", addresses: ["t-child", "t-parent"] });
  const visible = withEffective(state, terms.map(agent), terms);
  assert.equal(visible.effective["t-child"], undefined);
  assert.equal(visible.effective["t-parent"], undefined);
  assert.equal(visible.effective["t-sibling"].explicit, true);
  assert.equal(visible.effective["t-sibling"].inheritedFrom, "t-parent");
  assert.equal(isExplicitlyHidden(state, "t-sibling", terms[2]), true);
});

test("restore all clears group rules and individual roots", () => {
  const terms = [term("t-parent"), term("t-child", "t-parent")];
  let state = applyVisibilityAction(emptyVisibilityState(), { type: "hide", address: "t-parent" });
  state = applyVisibilityAction(state, { type: "hide", address: "t-other" });
  state = applyVisibilityAction(state, { type: "hide-group", group: { key: "space:s1", kind: "space", label: "Work" } });
  state = withEffective(state, terms.map(agent), terms);
  state = applyVisibilityAction(state, { type: "restore-all" });
  const cleared = withEffective(state, terms.map(agent), terms);
  assert.deepEqual(cleared.hidden, {});
  assert.deepEqual(cleared.groups, {});
  assert.deepEqual(cleared.effective, {});
});

test("machine-qualified addresses with the same terminal suffix stay independent", () => {
  const terms = [term("workbox/t-1"), term("otherbox/t-1")];
  const state = applyVisibilityAction(emptyVisibilityState(), { type: "hide", address: "workbox/t-1" });
  const effective = withEffective(state, terms.map(agent), terms);
  assert.deepEqual(terms.map((x) => x.address).filter((address) => !effective.effective[address]), ["otherbox/t-1"]);
});

test("same folder on local and remote machines has independent group rules", () => {
  const state = applyVisibilityAction(emptyVisibilityState(), {
    type: "hide-group",
    group: { key: "project:workbox:/repo", kind: "project", label: "repo", folder: "/repo", machine: "workbox" },
  });
  const terms = [term("local/t-1"), term("workbox/t-1")];
  const effective = groupEffectiveVisibility(state, terms.map(agent), terms, {
    groups: { "local/t-1": "project:/repo", "workbox/t-1": "project:workbox:/repo" },
  });
  assert.deepEqual(Object.keys(effective), ["workbox/t-1"]);
});

test("cleanup removes proven local endings but retains remote selections across offline boundaries", () => {
  const local = { hidden: { "t-local": {} } };
  assert.deepEqual(Object.keys(pruneEnded(local, [term("t-local", null, "exited")], []).hidden), []);
  const restarting = pruneEnded(local, [], []);
  assert.ok(restarting.hidden["t-local"], "an unloaded local core must not look ended");
  const localReady = pruneEnded(local, [], [{ name: null, layout: "ready" }]);
  assert.equal(localReady.hidden["t-local"], undefined);

  const remote = { hidden: { "workbox/t-remote": {} } };
  const offline = pruneEnded(remote, [], [{ name: "workbox", layout: "unavailable" }]);
  assert.ok(offline.hidden["workbox/t-remote"]);
  const loading = pruneEnded(remote, [], [{ name: "workbox", layout: "loading" }]);
  assert.ok(loading.hidden["workbox/t-remote"]);
  const ready = pruneEnded(remote, [], [{ name: "workbox", layout: "ready" }]);
  assert.equal(ready.hidden["workbox/t-remote"], undefined);
  const live = pruneEnded(remote, [term("workbox/t-remote")], [{ name: "workbox", layout: "ready" }]);
  assert.ok(live.hidden["workbox/t-remote"]);
});

test("hidden metadata preserves durable record binding across an empty restart frame", () => {
  const state = {
    hidden: {
      "workbox/t-live": { recordKey: "record-1", created_ms: 101, ignored: "drop" },
      "workbox/t-legacy": {},
    },
  };
  const normalized = normalizeVisibilityState(state);
  assert.deepEqual(normalized.hidden, {
    "workbox/t-live": { created_ms: 101, recordKey: "record-1" },
    "workbox/t-legacy": {},
  });
  const restarted = startVisibilitySession(normalized);
  assert.deepEqual(restarted.hidden, normalized.hidden);
  const retained = pruneEnded(restarted, [], [{ name: "workbox", layout: "ready" }]);
  assert.deepEqual(retained.hidden, { "workbox/t-live": { created_ms: 101, recordKey: "record-1" } });
  const ended = pruneEnded(normalized, [term("workbox/t-live", null, "exited")], [{ name: "workbox", layout: "ready" }]);
  assert.deepEqual(ended.hidden["workbox/t-live"], { created_ms: 101, recordKey: "record-1" });
});

test("a reused terminal address with a new epoch is not explicitly or transitively hidden", () => {
  const state = {
    hidden: {
      "t-parent": { recordKey: "record-old", created_ms: 101 },
    },
  };
  const terms = [
    terminalAt("t-parent", null, 202),
    terminalAt("t-child", "t-parent", 202),
  ];
  assert.equal(isExplicitlyHidden(state, "t-parent", terms[0]), false);
  assert.deepEqual(effectiveVisibility(state, terms.map(agent), terms), {});
});

test("the original terminal epoch remains hidden with descendant inheritance", () => {
  const state = {
    hidden: {
      "t-parent": { recordKey: "record-original", created_ms: 101 },
    },
  };
  const terms = [
    terminalAt("t-parent", null, 101),
    terminalAt("t-child", "t-parent", 101),
  ];
  const effective = effectiveVisibility(state, terms.map(agent), terms);
  assert.deepEqual(effective["t-parent"], { inheritedFrom: null, explicit: true });
  assert.deepEqual(effective["t-child"], { inheritedFrom: "t-parent", explicit: false });
});

test("restoring a group preserves independent individual hides", () => {
  const group = { key: "project:/repo", kind: "project", label: "repo", folder: "/repo", machine: null };
  let state = applyVisibilityAction(emptyVisibilityState(), { type: "hide", address: "t-parent" });
  state = applyVisibilityAction(state, { type: "hide-group", group });
  state = applyVisibilityAction(state, { type: "restore-group", groupKey: group.key });
  const effective = withEffective(state, [agent("t-parent")], [term("t-parent")]);
  assert.deepEqual(state.groups, {});
  assert.deepEqual(state.hidden, { "t-parent": {} });
  assert.deepEqual(effective.effective["t-parent"], { inheritedFrom: null, explicit: true });
});

test("omp terminals use the agent classifier", () => {
  const omp = { address: "t-omp", state: "live", agent: "omp", program: {} };
  const effective = withEffective({ hidden: { "t-omp": {} } }, [], [omp]);
  assert.deepEqual(effective.effective["t-omp"], { inheritedFrom: null, explicit: true });
});

test("status-reporting nonstandard live terminals classify as agents without shell false positives", () => {
  const terminal = { address: "unraid-dev/t-unknown", state: "live", agent: "helper", status: "idle", program: { key: "shell" } };
  assert.equal(isAgentTerminal(terminal, new Set()), true);
  assert.equal(isAgentTerminal({ address: "t-shell", state: "live", agent: "zsh", program: { key: "shell" } }, new Set()), false);
});
