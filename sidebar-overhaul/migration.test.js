import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMigrationExecutionPlan, executeMigration, identifyMigrationCandidates, migrationDestination, planMigration, preflightMigration, selectMigrationRecords } from "./migration.js";

const options = {
  machine: "local",
  sourceRoot: "/home/jason/.herdr/worktrees",
  destinationRoot: "/home/jason/.herdr/worktrees",
  knownRepositories: ["/home/jason/Reaparr"],
};

const worktree = (branch, overrides = {}) => ({
  path: `/home/jason/.herdr/worktrees/Reaparr-${branch}`,
  repository: "/home/jason/Reaparr",
  branch,
  herdrOwned: true,
  machine: "local",
  ...overrides,
});

test("eligible clean and dirty inactive worktrees get flat destinations and continue outcomes", () => {
  const clean = worktree("feature/clean");
  const dirty = worktree("feature/dirty", { dirty: true });
  const result = planMigration([clean, dirty], options);

  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0].status, "ready");
  assert.equal(result.outcomes[0].destination, "/home/jason/.herdr/worktrees/Reaparr-feature-clean");
  assert.equal(result.outcomes[1].status, "preview");
  assert.equal(result.outcomes[1].dirty, true);
  assert.equal(result.previews.length, 1);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(identifyMigrationCandidates([clean, dirty], options), [clean, dirty]);
});

test("migration destination uses repository basename and branch slug without filesystem access", () => {
  assert.equal(
    migrationDestination({ repository: "/src/Reaparr", branch: "feature/package upgrade" }, { destinationRoot: "/worktrees" }),
    "/worktrees/Reaparr-feature-package-upgrade",
  );
});

test("active worktrees are blocked by active cwd or explicit activity", () => {
  const cwdActive = worktree("feature/cwd");
  const explicitActive = worktree("feature/explicit", { active: true });
  const result = planMigration([cwdActive, explicitActive], { ...options, activeCwds: [cwdActive.path] });

  assert.deepEqual(result.outcomes.map((entry) => [entry.status, entry.reason]), [
    ["blocked", "active-worktree"],
    ["blocked", "active-worktree"],
  ]);
  assert.equal(result.candidates.length, 0);
});

test("detached worktrees are refused while processing continues", () => {
  const detached = worktree(null, { detached: true });
  const clean = worktree("feature/after-detached");
  const result = preflightMigration([detached, clean], options);

  assert.equal(result.outcomes[0].status, "blocked");
  assert.equal(result.outcomes[0].reason, "detached-head");
  assert.equal(result.outcomes[1].status, "ready");
});

test("occupied and duplicate destinations are blocked as collisions", () => {
  const occupied = worktree("feature/occupied");
  const duplicateA = worktree("feature/same", { path: "/old/a" });
  const duplicateB = worktree("feature/same", { path: "/old/b" });
  const result = planMigration([occupied, duplicateA, duplicateB], {
    ...options,
    existingDestinations: ["/home/jason/.herdr/worktrees/Reaparr-feature-occupied"],
  });

  assert.deepEqual(result.outcomes.map((entry) => [entry.status, entry.reason]), [
    ["blocked", "destination-collision"],
    ["blocked", "destination-collision"],
    ["blocked", "destination-collision"],
  ]);
  assert.equal(result.blocked.length, 3);
});

test("non-Herdr-owned worktrees are excluded", () => {
  const foreign = worktree("feature/foreign", { herdrOwned: false });
  const outsideRoot = worktree("feature/outside", { herdrOwned: undefined, path: "/tmp/foreign-worktree" });
  const result = planMigration([foreign, outsideRoot], options);

  assert.deepEqual(result.outcomes.map((entry) => [entry.status, entry.reason]), [
    ["excluded", "not-herdr-owned"],
    ["excluded", "not-herdr-owned"],
  ]);
  assert.equal(result.candidates.length, 0);
});

test("main checkout, cross-machine, and unknown repositories are excluded or blocked", () => {
  const main = { ...worktree("main"), path: "/home/jason/Reaparr" };
  const remote = worktree("feature/remote", { machine: "unraid-dev" });
  const unknown = worktree("feature/unknown", { repository: "/home/jason/Other" });
  const result = planMigration([main, remote, unknown], options);

  assert.equal(result.outcomes[0].reason, "main-checkout");
  assert.equal(result.outcomes[0].status, "excluded");
  assert.equal(result.outcomes[1].reason, "cross-machine");
  assert.equal(result.outcomes[1].status, "blocked");
  assert.equal(result.outcomes[2].reason, "unknown-repository");
  assert.equal(result.outcomes[2].status, "excluded");
});

test("selection is same-machine and per-record without widening the selected set", () => {
  const local = worktree("feature/local");
  const remote = worktree("feature/remote", { machine: "unraid-dev" });
  const selected = selectMigrationRecords([local, remote], [local.path]);
  assert.deepEqual(selected, [local]);
  const plan = buildMigrationExecutionPlan([local, remote], { ...options, selection: [local.path] });
  assert.deepEqual(plan.actions.map((entry) => entry.action), ["move"]);
  assert.equal(plan.actions[0].destination, "/home/jason/.herdr/worktrees/Reaparr-feature-local");
});

test("execution refuses dirty, detached, active, and cross-machine records without invoking the effect", async () => {
  const records = [
    worktree("feature/dirty", { dirty: true }),
    worktree("feature/detached", { detached: true }),
    worktree("feature/active", { active: true }),
    worktree("feature/remote", { machine: "unraid-dev" }),
  ];
  const plan = buildMigrationExecutionPlan(records, options);
  const calls = [];
  const result = await executeMigration(plan, { move: (...args) => calls.push(args) });
  assert.deepEqual(calls, []);
  assert.deepEqual(result.results.map((entry) => entry.outcome), ["skipped", "skipped", "skipped", "skipped"]);
  assert.deepEqual(result.results.map((entry) => entry.reason), ["dirty-worktree-preview", "detached-head", "active-worktree", "cross-machine"]);
});

test("execution continues after one move failure and reports successes and failures", async () => {
  const first = worktree("feature/first");
  const second = worktree("feature/second");
  const plan = buildMigrationExecutionPlan([first, second], options);
  const calls = [];
  const result = await executeMigration(plan, {
    move: async (source, destination) => {
      calls.push([source, destination]);
      if (source === first.path) throw new Error("permission denied");
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.successes.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].error, "permission denied");
  assert.equal(result.successes[0].record, second);
});

test("execution plan and preflight have no side effects", () => {
  const clean = worktree("feature/no-side-effects");
  const before = JSON.stringify(clean);
  const plan = buildMigrationExecutionPlan([clean], { ...options, selection: [clean] });
  assert.equal(JSON.stringify(clean), before);
  assert.equal(plan.actions[0].action, "move");
});

test("migration accepts path-keyed repositories, branch aliases, normalized active paths, and canonical containment", () => {
  const aliased = worktree("feature/alias", { branch: undefined, branchName: "feature/alias" });
  const result = planMigration([aliased], { ...options, knownRepositories: { "/home/jason/Reaparr": {} }, activePaths: [], activeSpaces: [{ cwd: `${aliased.path}\\` }] });
  assert.equal(result.outcomes[0].reason, "active-worktree");

  const outside = worktree("feature/outside", { herdrOwned: undefined, path: "/home/jason/.herdr/worktrees/../outside" });
  const outsideResult = planMigration([outside], options);
  assert.equal(outsideResult.outcomes[0].reason, "not-herdr-owned");
});
