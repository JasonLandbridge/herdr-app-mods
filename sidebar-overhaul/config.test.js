import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadConfig,
  branchSlug,
  findDestinationCollisions,
  flatDestination,
  hasDestinationCollision,
  lookupLocation,
  lookupMachineOption,
  lookupOption,
  lookupProject,
  lookupRepository,
  machineKey,
  parseConfig,
  repositoryBasename,
  validateConfig,
  validateRepositoryBasename,
  validateWorktreeDirectory,
} from "./config.js";

const config = {
  version: 1,
  machines: {
    local: {
      worktreeDirectory: "/home/jason/.herdr/worktrees",
      locations: { chats: "~", projects: "~" },
      projects: { pinned: ["/home/jason/Reaparr"], hidden: [], listed: [], unpinned: [] },
    },
    "unraid-dev": {
      worktreeDirectory: "/workspaces/.herdr/worktrees",
      locations: { chats: "~", projects: "/workspaces" },
      projects: { pinned: [{ path: "/workspaces/Reaparr", name: "Reaparr" }], hidden: [], listed: [], unpinned: [] },
    },
  },
  repositories: { "/workspaces/Reaparr": { icon: "reaparr.svg" } },
  options: { layout: "expanded", dirty: true },
};

test("machineKey maps null to local and rejects invalid keys", () => {
  assert.equal(machineKey(null), "local");
  assert.equal(machineKey("unraid-dev"), "unraid-dev");
  assert.throws(() => machineKey(""), /machine/);
  assert.throws(() => machineKey("bad\nkey"), /machine/);
});

test("literal worktree roots require absolute, non-template paths", () => {
  assert.equal(validateWorktreeDirectory("/workspaces/.herdr/worktrees"), "/workspaces/.herdr/worktrees");
  assert.equal(validateWorktreeDirectory("C:\\worktrees"), "C:\\worktrees");
  assert.throws(() => validateWorktreeDirectory("worktrees"), /absolute/);
  assert.throws(() => validateWorktreeDirectory("~/.herdr/worktrees"), /literal/);
  assert.throws(() => validateWorktreeDirectory("/worktrees/{repo}"), /literal/);
  assert.throws(() => validateWorktreeDirectory(""), /non-empty/);
});

test("repository names and paths resolve to a safe basename", () => {
  assert.equal(validateRepositoryBasename("Reaparr"), "Reaparr");
  assert.equal(repositoryBasename("/workspaces/Reaparr"), "Reaparr");
  assert.equal(repositoryBasename("C:\\workspaces\\Reaparr\\"), "Reaparr");
  assert.throws(() => validateRepositoryBasename("a/b"), /basename/);
  assert.throws(() => validateRepositoryBasename(".."), /basename/);
});

test("flat destination uses the worktree root, repository basename and built-in branch slug", () => {
  assert.equal(branchSlug("feature/package upgrade"), "feature-package-upgrade");
  assert.equal(
    flatDestination("/workspaces/.herdr/worktrees", "/workspaces/Reaparr", "package-upgrade"),
    "/workspaces/.herdr/worktrees/Reaparr-package-upgrade",
  );
  assert.equal(
    flatDestination("/workspaces/.herdr/worktrees", "/workspaces/Reaparr", "feature/foo"),
    "/workspaces/.herdr/worktrees/Reaparr-feature-foo",
  );
});

test("collision helpers identify duplicate flat destinations without filesystem access", () => {
  const destinations = [
    "/worktrees/Reaparr-feature-foo",
    { destination: "/worktrees/MusicBumble-main" },
    { path: "/worktrees/Reaparr-feature-foo" },
    "/worktrees/Reaparr-feature-foo",
  ];
  assert.equal(hasDestinationCollision("/worktrees/Reaparr-feature-foo", destinations), true);
  assert.equal(hasDestinationCollision("/worktrees/other", destinations), false);
  assert.deepEqual(findDestinationCollisions(destinations), ["/worktrees/Reaparr-feature-foo"]);
});

test("strict config parsing supports local and remote machine entries", () => {
  assert.deepEqual(parseConfig(JSON.stringify(config)), config);
  assert.deepEqual(validateConfig(config), config);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, machines: { local: { ...config.machines.local, worktreeDirectory: "relative" } } })), /absolute/);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, machines: { ...config.machines, local: undefined } })), /machines must define local/);
});

test("custom project folders are optional per-machine, safe, and unique", () => {
  const custom = { ...config, machines: { ...config.machines, local: { ...config.machines.local, customProjects: ["/srv/projects/Repo", "/home/dev/Archive"] } } };
  assert.deepEqual(parseConfig(JSON.stringify(custom)).machines.local.customProjects, custom.machines.local.customProjects);
  assert.throws(() => validateConfig({ ...custom, machines: { ...custom.machines, local: { ...custom.machines.local, customProjects: "bad" } } }), /must be an array/);
  assert.throws(() => validateConfig({ ...custom, machines: { ...custom.machines, local: { ...custom.machines.local, customProjects: ["/srv/Repo", "/srv/Repo"] } } }), /must be unique/);
  assert.throws(() => validateConfig({ ...custom, machines: { ...custom.machines, local: { ...custom.machines.local, customProjects: ["/srv/../Repo"] } } }), /cannot contain \.\./);
});


test("declarative lookups preserve local/remote identity and return fallback when absent", () => {
  assert.equal(lookupOption(config, "layout"), "expanded");
  assert.equal(lookupOption(config, "missing", "fallback"), "fallback");
  assert.equal(lookupLocation(config, null, "projects"), "~");
  assert.equal(lookupLocation(config, "unraid-dev", "projects"), "/workspaces");
  assert.equal(lookupProject(config, "unraid-dev", "/workspaces/Reaparr").name, "Reaparr");
  assert.equal(lookupProject(config, null, "/workspaces/Reaparr"), undefined);
  assert.deepEqual(lookupRepository(config, "/workspaces/Reaparr"), { icon: "reaparr.svg" });
  assert.deepEqual(lookupRepository(config, "/somewhere/Reaparr"), { icon: "reaparr.svg" });
  assert.equal(lookupRepository(config, "/workspaces/Missing"), undefined);
});

test("each machine can override legacy automatic discovery and handoff independently", () => {
  const legacy = { ...config, options: { keepUpToDate: true, handoffRule: true, computers: { "unraid-dev": { handoffRule: true } } } };
  const remote = "unraid-dev";
  assert.equal(lookupMachineOption(legacy, remote, "keepUpToDate", false), true);
  assert.equal(lookupMachineOption(legacy, remote, "handoffRule", false), true);
  assert.equal(lookupMachineOption(legacy, "other", "handoffRule", false), false);
  const override = { ...legacy, machines: { ...legacy.machines, [remote]: { ...legacy.machines[remote], options: { keepUpToDate: false, handoffRule: false } } } };
  assert.equal(lookupMachineOption(override, remote, "keepUpToDate", true), false);
  assert.equal(lookupMachineOption(override, remote, "handoffRule", true), false);
  assert.equal(lookupMachineOption(override, null, "keepUpToDate", false), true);
  assert.equal(lookupMachineOption(override, null, "handoffRule", false), true);
});

test("first launch bootstraps portable settings when no config is shipped", async () => {
  let saved;
  const result = await loadConfig({
    path: "sidebar.config.json",
    readTextFile: async () => null,
    writeTextFile: async (_path, text) => { saved = text; },
    observed: { home: "/home/example" },
  });
  assert.equal(result.bootstrapped, true);
  assert.equal(parseConfig(saved).machines.local.worktreeDirectory, "/home/example/.herdr/worktrees");
  assert.deepEqual(parseConfig(saved).machines.local.projects.pinned, []);
});
