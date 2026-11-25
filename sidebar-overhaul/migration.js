// Pure worktree migration planning. No filesystem or Herdr dependencies.
import { flatDestination } from "./config.js";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const valueOf = (record, keys) => {
  for (const key of keys) if (own(record, key) && record[key] !== undefined) return record[key];
  return undefined;
};

const pathValue = (value) => {
  if (typeof value === "string") return value;
  if (!object(value)) return null;
  return value.path ?? value.folder ?? value.cwd ?? value.root ?? null;
};

const pathKey = (value) => {
  const path = pathValue(value);
  if (typeof path !== "string" || !path) return null;
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/");
  const parts = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length && parts.at(-1) !== "..") parts.pop(); else if (!absolute) parts.push(part); }
    else parts.push(part);
  }
  const result = `${absolute ? "/" : ""}${parts.join("/")}`;
  return result || (absolute ? "/" : null);
};

const pathWithin = (path, root) => {
  const child = pathKey(path);
  const base = pathKey(root);
  return Boolean(child && base && (child === base || child.startsWith(`${base}/`)));
};

const machineKey = (machine) => machine === null || machine === undefined ? "local" : machine;

const recordPath = (record) => pathValue(valueOf(record, ["path", "worktree", "folder", "cwd"]));
const repositoryPath = (record) => pathValue(valueOf(record, ["repository", "repoPath", "repositoryPath", "mainPath", "sourceRepository", "root", "repo"]));
const branchOf = (record) => {
  const branch = valueOf(record, ["branch", "branchName", "ref"]);
  return typeof branch === "string" ? branch.replace(/^refs\/heads\//, "") : branch;
};


const knownRepository = (record, options) => {
  const known = options.knownRepositories ?? options.repositories ?? options.knownRepos;
  if (known == null) return true;
  const repository = pathKey(repositoryPath(record));
  if (!repository) return false;
  const values = known instanceof Set ? [...known] : Array.isArray(known) ? known : [...Object.keys(known), ...Object.values(known)];
  return values.some((entry) => pathKey(entry) === repository || pathKey(entry?.path ?? entry?.root ?? entry?.repository) === repository);
};

const isMain = (record, options) => {
  if (record.isMain === true || record.main === true || record.primary === true || record.linked === false) return true;
  const path = pathKey(recordPath(record));
  const repository = pathKey(repositoryPath(record));
  if (path && repository && path === repository) return true;
  const mainPaths = options.mainPaths ?? options.mainCheckouts;
  if (mainPaths == null) return false;
  const values = mainPaths instanceof Set ? [...mainPaths] : Array.isArray(mainPaths) ? mainPaths : Object.values(mainPaths);
  return values.some((entry) => pathKey(entry) === path);
};

const isDetached = (record) => record.detached === true || record.isDetached === true || record.head === "HEAD" || branchOf(record) === null || branchOf(record) === undefined || branchOf(record) === "";

const isHerdrOwned = (record, options) => {
  if (record.herdrOwned === false || record.ownedBy === "other" || record.owner === "other" || record.managedBy === "other") return false;
  if (record.herdrOwned === true || record.ownedBy === "herdr" || record.owner === "herdr" || record.managedBy === "herdr") return true;
  const sourceRoot = options.sourceRoot ?? options.herdrRoot ?? options.sourceWorktreeRoot;
  return sourceRoot != null && pathWithin(recordPath(record), sourceRoot);
};

const isCrossMachine = (record, options) => {
  if (record.crossMachine === true || record.sameMachine === false) return true;
  const current = machineKey(options.machine ?? options.sourceMachine);
  const machine = valueOf(record, ["machine", "sourceMachine", "host"]);
  return machine !== undefined && machine !== null && machineKey(machine) !== current;
};

const activePathSet = (options) => {
  const values = [
    ...(options.activePaths ?? []),
    ...(options.activeCwds ?? []),
    ...(options.terminalCwds ?? []),
    ...(options.activeTerminalCwds ?? []),
    ...(options.activeSpaces ?? []),
    ...(options.activeWorktrees ?? []),
  ];
  return new Set(values.map(pathKey).filter(Boolean));
};

const isActive = (record, options, paths) => {
  if (record.active === true || record.activeSpace === true || record.activeTerminal === true || record.spaceActive === true || record.terminalActive === true) return true;
  const path = pathKey(recordPath(record));
  if (path && paths.has(path)) return true;
  const space = record.space;
  if (object(space) && (space.active === true || space.terminalActive === true || pathKey(space.cwd) === pathKey(recordPath(record)))) return true;
  return false;
};

const isDirty = (record) => record.dirty === true || record.modified === true || record.clean === false || (typeof record.status === "string" && record.status.trim() !== "" && record.status !== "clean");

const existingDestinations = (options) => {
  const values = [
    ...(options.existingDestinations ?? []),
    ...(options.destinations ?? []),
    ...(options.occupiedDestinations ?? []),
    ...(options.existingWorktrees ?? []),
  ];
  return new Set(values.map(pathKey).filter(Boolean));
};

const reasonText = {
  main: "main-checkout",
  detached: "detached-head",
  notOwned: "not-herdr-owned",
  unknownRepository: "unknown-repository",
  crossMachine: "cross-machine",
  active: "active-worktree",
  missingPath: "missing-worktree-path",
  missingBranch: "missing-branch",
  missingRepository: "missing-repository",
  invalidDestination: "invalid-destination",
  collision: "destination-collision",
};

const excluded = (record, reason, extra = {}) => ({ record, status: "excluded", outcome: "excluded", reason, ...extra });
const blocked = (record, reason, extra = {}) => ({ record, status: "blocked", outcome: "blocked", reason, ...extra });

const selectionValues = (selection) => {
  if (selection == null) return null;
  if (typeof selection === "function") return selection;
  if (selection instanceof Set) return [...selection];
  if (Array.isArray(selection)) return selection;
  if (object(selection)) {
    const values = selection.records ?? selection.worktrees ?? selection.entries ?? selection.repositories ?? selection.repos ?? selection.paths ?? selection.selected;
    if (values !== undefined) return values instanceof Set ? [...values] : Array.isArray(values) ? values : [values];
  }
  return [selection];
};

const selectionPath = (value) => {
  if (typeof value === "string") return pathKey(value);
  if (!object(value)) return null;
  return pathKey(value.path ?? value.worktree ?? value.folder ?? value.cwd ?? value.repository ?? value.repoPath ?? value.repositoryPath ?? value.mainPath ?? value.root ?? value.repo);
};

const selectionMatches = (record, index, values) => {
  if (typeof values === "function") return Boolean(values(record, index));
  const path = object(record) ? pathKey(recordPath(record)) : null;
  const repository = object(record) ? pathKey(repositoryPath(record)) : null;
  return values.some((value) => {
    if (value === record || value === index) return true;
    const selectedPath = selectionPath(value);
    return Boolean(selectedPath && (selectedPath === path || selectedPath === repository));
  });
};

/**
 * Select worktree records without touching the filesystem. Selection values may
 * be records, indexes, worktree paths, repository paths, or an object with one
 * of `records`, `repositories`, `paths`, or `selected` collections.
 */
export function selectMigrationRecords(records, selection) {
  if (!Array.isArray(records)) throw new TypeError("Migration records must be an array");
  const values = selectionValues(selection);
  return values === null ? records.slice() : records.filter((record, index) => selectionMatches(record, index, values));
};

const errorText = (error) => String(error?.message ?? error ?? "Migration move failed");

export function identifyMigrationCandidates(records, options = {}) {
  return planMigration(records, options).candidates.map((entry) => entry.record);
}
export function migrationDestination(record, options = {}) {
  const base = options.destinationRoot ?? options.worktreeDirectory ?? options.base;
  const repository = repositoryPath(record);
  const branch = branchOf(record);
  if (typeof base !== "string" || !base) throw new TypeError(reasonText.invalidDestination);
  if (typeof repository !== "string" || !repository) throw new TypeError(reasonText.missingRepository);
  if (typeof branch !== "string" || !branch) throw new TypeError(reasonText.missingBranch);
  return flatDestination(base, repository, branch);
}

export function planMigration(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("Migration records must be an array");
  const activePaths = activePathSet(options);
  const occupied = existingDestinations(options);
  const outcomes = records.map((record) => {
    if (!object(record)) return excluded(record, reasonText.missingPath);
    if (isMain(record, options)) return excluded(record, reasonText.main);
    if (isDetached(record)) return blocked(record, reasonText.detached);
    if (!recordPath(record)) return excluded(record, reasonText.missingPath);
    if (!isHerdrOwned(record, options)) return excluded(record, reasonText.notOwned);
    if (!knownRepository(record, options)) return excluded(record, reasonText.unknownRepository);
    if (isCrossMachine(record, options)) return blocked(record, reasonText.crossMachine);
    if (isActive(record, options, activePaths)) return blocked(record, reasonText.active);

    let destination;
    try { destination = migrationDestination(record, options); }
    catch (error) { return blocked(record, error.message === reasonText.missingRepository ? reasonText.missingRepository : error.message === reasonText.missingBranch ? reasonText.missingBranch : reasonText.invalidDestination); }
    const collision = occupied.has(pathKey(destination));
    const dirty = isDirty(record);
    return collision
      ? blocked(record, reasonText.collision, { destination, dirty })
      : { record, status: dirty ? "preview" : "ready", outcome: dirty ? "preview" : "ready", destination, dirty };
  });

  const destinations = new Map();
  for (const entry of outcomes) if (entry.destination && (entry.status === "ready" || entry.status === "preview")) {
    const key = pathKey(entry.destination);
    const list = destinations.get(key) ?? [];
    list.push(entry);
    destinations.set(key, list);
  }
  for (const list of destinations.values()) if (list.length > 1) {
    for (const entry of list) {
      entry.status = "blocked";
      entry.outcome = "blocked";
      entry.reason = reasonText.collision;
    }
  }

  return {
    outcomes,
    candidates: outcomes.filter((entry) => entry.status === "ready" || entry.status === "preview"),
    ready: outcomes.filter((entry) => entry.status === "ready"),
    previews: outcomes.filter((entry) => entry.status === "preview"),
    blocked: outcomes.filter((entry) => entry.status === "blocked"),
    excluded: outcomes.filter((entry) => entry.status === "excluded"),
  };
}

/** Alias-free named preflight entry point for callers that do not intend to execute a plan. */
export function preflightMigration(records, options = {}) {
  return planMigration(records, options);
}
const actionFor = (entry) => {
  const source = object(entry.record) ? recordPath(entry.record) : null;
  if (entry.status === "ready") return { ...entry, action: "move", source };
  if (entry.status === "preview") return { ...entry, action: "preview", source, reason: "dirty-worktree-preview" };
  return { ...entry, action: "skip", source };
};

/**
 * Build deterministic, user-selected migration actions without filesystem or
 * git effects. Dirty records remain previews until execution confirms them.
 */
export function buildMigrationExecutionPlan(records, options = {}) {
  const selection = options.selection ?? options.selected;
  const selected = selectMigrationRecords(records, selection);
  const preflight = planMigration(selected, options);
  const actions = preflight.outcomes.map(actionFor);
  return {
    ...preflight,
    records: selected,
    selected,
    actions,
    executable: actions.filter((entry) => entry.action === "move"),
  };
}

const moveEffect = (options) => options.move ?? options.effects?.move ?? options.io?.move;

/** Execute a reviewed plan through an injected move effect, continuing after failures. */
export async function executeMigration(plan, options = {}) {
  if (!object(plan) || !Array.isArray(plan.actions)) throw new TypeError("Migration execution plan must contain actions");
  const move = moveEffect(options);
  if (typeof move !== "function") throw new TypeError("Migration move effect must be provided");
  const confirmDirty = options.confirmDirty === true;
  const results = [];

  for (const action of plan.actions) {
    if (action.action === "skip") {
      results.push({ ...action, outcome: "skipped" });
      continue;
    }
    if (action.action === "preview" && !confirmDirty) {
      results.push({ ...action, outcome: "skipped", reason: "dirty-worktree-preview" });
      continue;
    }
    try {
      await move(action.source, action.destination, action);
      results.push({ ...action, status: "succeeded", outcome: "succeeded" });
    } catch (error) {
      results.push({ ...action, status: "failed", outcome: "failed", error: errorText(error) });
    }
  }

  return {
    plan,
    results,
    successes: results.filter((entry) => entry.outcome === "succeeded"),
    failures: results.filter((entry) => entry.outcome === "failed"),
    skipped: results.filter((entry) => entry.outcome === "skipped"),
  };
}
