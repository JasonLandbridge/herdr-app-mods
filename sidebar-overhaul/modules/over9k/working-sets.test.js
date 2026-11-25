import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKING_SETS_STATE,
  applyWorkingSet,
  applyWorkingSetVisibility,
  deleteWorkingSet,
  emptyWorkingSetsState,
  normalizeWorkingSetsState,
  renameWorkingSet,
  saveWorkingSet,
  selectWorkingSet,
  selectorsEqual,
  visibleGroupSelectors,
  workingSetEntries,
} from "./working-sets.js";

const groups = new Map([
  ["d:/home/dev/project-a", { key: "d:/home/dev/project-a", label: "project-a", folder: "/home/dev/project-a", machine: null, kind: "project" }],
  ["r:buildbox:/work/project-b", { key: "r:buildbox:/work/project-b", label: "project-b", folder: "/work/project-b", machine: "buildbox", kind: "project" }],
]);

test("working-set registry persists selectors and active selection", () => {
  assert.equal(WORKING_SETS_STATE, "over9k.workingSets");
  const selectors = visibleGroupSelectors(groups);
  let state = saveWorkingSet(emptyWorkingSetsState(), { id: "focus", name: "Focus", selectors }, 10);
  assert.equal(state.active, "focus");
  assert.deepEqual(workingSetEntries(state)[0].selectors, selectors);
  assert.equal(normalizeWorkingSetsState(state).sets.focus.name, "Focus");
});

test("all projects and selected set preserve individual hides while changing groups", () => {
  const selectors = visibleGroupSelectors(groups);
  const visibility = { open: false, hidden: { "unraid-dev/t1": {} }, groups: { [selectors[0].key]: selectors[0] }, effective: { stale: {} }, groupEffective: { stale: {} } };
  const selected = applyWorkingSetVisibility(visibility, [selectors[1]], selectors);
  assert.deepEqual(selected.hidden, visibility.hidden);
  assert.deepEqual(Object.keys(selected.groups), [selectors[0].key]);
  const all = applyWorkingSetVisibility(selected, "all", selectors);
  assert.deepEqual(all.hidden, visibility.hidden);
  assert.deepEqual(all.groups, {});
});

test("set lifecycle rename select and delete is deterministic", () => {
  let state = saveWorkingSet(emptyWorkingSetsState(), { id: "one", name: "One", selectors: [] }, 10);
  state = saveWorkingSet(state, { id: "two", name: "Two", selectors: [] }, 20);
  state = renameWorkingSet(state, "one", "Renamed", 30);
  state = selectWorkingSet(state, "one");
  assert.equal(state.active, "one");
  assert.equal(state.sets.one.name, "Renamed");
  state = deleteWorkingSet(state, "one");
  assert.equal(state.active, null);
  assert.deepEqual(Object.keys(state.sets), ["two"]);
});

test("applying an unknown set does not alter visibility", () => {
  const visibility = { hidden: { a: {} }, groups: { g: {} } };
  assert.deepEqual(applyWorkingSet(emptyWorkingSetsState(), visibility, "missing", [{ key: "g" }]), visibility);
});

test("selector comparisons ignore display labels and preserve machine-qualified keys", () => {
  const selectors = visibleGroupSelectors(groups);
  assert.equal(selectors[1].machine, "buildbox");
  assert.equal(selectorsEqual(selectors, selectors.map((x) => ({ ...x, label: "renamed" }))), true);
});
