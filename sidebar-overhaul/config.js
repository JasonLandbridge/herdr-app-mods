// Pure helpers for the declarative sidebar.config.json schema.
// This module deliberately has no Herdr or filesystem dependencies.

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const fail = (message) => {
  throw new TypeError(`Invalid sidebar config: ${message}`);
};

/** The canonical key for a Herdr machine. The null machine is local. */
export function machineKey(machine) {
  if (machine === null) return "local";
  if (typeof machine !== "string" || machine.length === 0 || /[\u0000-\u001f\u007f]/.test(machine)) {
    fail("machine must be null or a non-empty machine key");
  }
  return machine;
}

/**
 * Validate and return a literal absolute worktree directory.
 *
 * A worktree directory is a directory, not a template: `~`, `{repo}`, and
 * relative paths are intentionally rejected. The value is not normalized.
 */
export function validateWorktreeDirectory(directory) {
  if (typeof directory !== "string" || directory.length === 0) fail("worktreeDirectory must be a non-empty string");
  if (/[\u0000-\u001f\u007f]/.test(directory)) fail("worktreeDirectory contains control characters");
  if (directory.includes("~") || /[{}]/.test(directory)) fail("worktreeDirectory must be literal, not a template");
  if (!directory.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(directory)) fail("worktreeDirectory must be absolute");
  return directory;
}

const validateText = (value, message) => {
  if (typeof value !== "string" || value.length === 0) fail(message);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${message} contains control characters`);
  return value;
};

const validateIcon = (icon, message) => {
  validateText(icon, message);
  if (icon.startsWith("/") || /^[A-Za-z]:[\\/]/.test(icon) || icon.startsWith("~") || icon.split(/[\\/]/).includes("..")) {
    fail(`${message} must be source-relative`);
  }
  return icon;
};

/** Validate a repository basename (not a path). */
export function validateRepositoryBasename(name) {
  if (typeof name !== "string" || name.length === 0) fail("repository basename must be a non-empty string");
  if (name === "." || name === ".." || /[\\/\u0000-\u001f\u007f]/.test(name)) fail("repository basename must contain no path separators");
  return name;
}

/** Return and validate the final path component of a repository path. */
export function repositoryBasename(repository) {
  if (typeof repository !== "string" || repository.length === 0) fail("repository must be a non-empty string");
  const value = repository.replace(/[\\/]+$/, "");
  const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  return validateRepositoryBasename(name);
}

/** Same branch slug semantics as the built-in worktree creator. */
export function branchSlug(branch) {
  if (typeof branch !== "string" || branch.length === 0) fail("branch must be a non-empty string");
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Resolve the flat checkout destination `<base>/<repo>-<branch-slug>`. */
export function flatDestination(base, repository, branch) {
  const root = validateWorktreeDirectory(base).replace(/[\\/]+$/, "");
  const repo = repositoryBasename(repository);
  const slug = branchSlug(branch);
  if (!slug) fail("branch must produce a non-empty slug");
  return `${root}/${repo}-${slug}`;
}

const destinationValue = (entry) => {
  if (typeof entry === "string") return entry;
  if (isObject(entry)) return entry.destination ?? entry.path ?? entry.folder ?? null;
  return null;
};

/** Whether a destination is already present in a collection of paths/records. */
export function hasDestinationCollision(destination, existing) {
  if (typeof destination !== "string") fail("destination must be a string");
  if (existing == null) return false;
  const values = existing instanceof Set ? existing : Array.isArray(existing) ? existing : Object.values(existing);
  return [...values].some((entry) => destinationValue(entry) === destination);
}

/** Return duplicate destination paths, in first-seen order. */
export function findDestinationCollisions(destinations) {
  if (!Array.isArray(destinations)) fail("destinations must be an array");
  const seen = new Set();
  const reported = new Set();
  const collisions = [];
  for (const entry of destinations) {
    const destination = destinationValue(entry);
    if (typeof destination !== "string") fail("destination entries must be paths or records with a path");
    if (seen.has(destination) && !reported.has(destination)) {
      reported.add(destination);
      collisions.push(destination);
    }
    seen.add(destination);
  }
  return collisions;
}

/** Parse JSON text and strictly validate the resulting declarative config. */
export function parseConfig(text) {
  if (typeof text !== "string") fail("config text must be a string");
  let config;
  try { config = JSON.parse(text); }
  catch (error) { throw new TypeError(`Invalid sidebar config JSON: ${error.message}`); }
  return validateConfig(config);
}

/** Strictly validate a parsed sidebar configuration and return it unchanged. */
export function validateConfig(config) {
  if (!isObject(config)) fail("config must be an object");
  if (config.version !== 1) fail("version must be 1");
  if (!isObject(config.machines)) fail("machines must be an object");
  if (!own(config.machines, "local")) fail("machines must define local");

  for (const [key, machine] of Object.entries(config.machines)) {
    machineKey(key);
    if (!isObject(machine)) fail(`machine ${key} must be an object`);
    validateWorktreeDirectory(machine.worktreeDirectory);
    if (!isObject(machine.locations)) fail(`machine ${key}.locations must be an object`);
    for (const [location, value] of Object.entries(machine.locations)) validateText(value, `machine ${key}.locations.${location} must be a non-empty string`);
    if (!isObject(machine.projects)) fail(`machine ${key}.projects must be an object`);
    for (const [group, entries] of Object.entries(machine.projects)) {
      if (!Array.isArray(entries)) fail(`machine ${key}.projects.${group} must be an array`);
      for (const entry of entries) {
        if (typeof entry === "string") { validateText(entry, `machine ${key}.projects.${group} entries need a path`); continue; }
        if (!isObject(entry)) fail(`machine ${key}.projects.${group} entries must be strings or objects`);
        validateText(entry.path ?? entry.repo, `machine ${key}.projects.${group} entries need a path`);
        if (own(entry, "name")) validateText(entry.name, `machine ${key}.projects.${group} entry name must be non-empty`);
        if (own(entry, "color")) validateText(entry.color, `machine ${key}.projects.${group} entry color must be non-empty`);
        if (own(entry, "icon")) validateIcon(entry.icon, `machine ${key}.projects.${group} entry icon`);
      }
    }
    if (own(machine, "customProjects")) {
      if (!Array.isArray(machine.customProjects)) fail(`machine ${key}.customProjects must be an array`);
      const paths = new Set();
      for (const path of machine.customProjects) {
        validateText(path, `machine ${key}.customProjects entries must be non-empty paths`);
        if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) fail(`machine ${key}.customProjects entries must be absolute`);
        if (path.split(/[\\/]/).includes("..")) fail(`machine ${key}.customProjects entries cannot contain .. segments`);
        if (paths.has(path)) fail(`machine ${key}.customProjects entries must be unique`);
        paths.add(path);
      }
    }
  }

  if (!isObject(config.repositories)) fail("repositories must be an object");
  for (const [repository, settings] of Object.entries(config.repositories)) {
    repositoryBasename(repository);
    if (!isObject(settings)) fail(`repository ${repository} must be an object`);
    for (const key of ["name", "color"]) if (own(settings, key)) validateText(settings[key], `repository ${repository}.${key} must be non-empty`);
    if (own(settings, "icon")) validateIcon(settings.icon, `repository ${repository}.icon`);
  }
  if (!isObject(config.options)) fail("options must be an object");
  return config;
}

const machineConfig = (config, machine) => config?.machines?.[machineKey(machine)];

/** Declaratively read one top-level sidebar option. */
export function lookupOption(config, key, fallback) {
  if (typeof key !== "string" || key.length === 0) fail("option key must be a non-empty string");
  return own(config?.options ?? {}, key) ? config.options[key] : fallback;
}
/** Read a machine option before its applicable legacy setting and fallback. */
export function lookupMachineOption(config, machine, key, fallback) {
  if (typeof key !== "string" || key.length === 0) fail("option key must be a non-empty string");
  const options = machineConfig(config, machine)?.options ?? {};
  if (own(options, key)) return options[key];
  if (key === "handoffRule" && machine !== null) {
    const remote = config?.options?.computers?.[machineKey(machine)];
    return own(remote ?? {}, key) ? remote[key] : fallback;
  }
  return lookupOption(config, key, fallback);
}

/** Declaratively read one location for a local or remote machine. */
export function lookupLocation(config, machine, key, fallback) {
  if (typeof key !== "string" || key.length === 0) fail("location key must be a non-empty string");
  const locations = machineConfig(config, machine)?.locations ?? {};
  return own(locations, key) ? locations[key] : fallback;
}

const projectPath = (entry) => typeof entry === "string" ? entry : entry?.path ?? entry?.repo;

/** Declaratively find a project in any configured project group. */
export function lookupProject(config, machine, project) {
  if (typeof project !== "string" || project.length === 0) return undefined;
  const groups = machineConfig(config, machine)?.projects ?? {};
  for (const entries of Object.values(groups)) {
    const found = entries.find((entry) => projectPath(entry) === project);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Declaratively find repository settings by path/key or by repository basename. */
export function lookupRepository(config, repository) {
  if (typeof repository !== "string" || repository.length === 0) return undefined;
  const repositories = config?.repositories ?? {};
  if (own(repositories, repository)) return repositories[repository];
  const name = repositoryBasename(repository);
  const keys = Object.keys(repositories).filter((candidate) => repositoryBasename(candidate) === name);
  return keys.length === 1 ? repositories[keys[0]] : undefined;
}

/** Serialize a validated sidebar configuration with stable human-editable formatting. */
export function serializeConfig(config) {
  validateConfig(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const missingFile = (error) => error?.code === "ENOENT" || /not found|no such file|missing/i.test(String(error?.message ?? error));

const projectGroups = (state = {}, metadata = {}) => {
  const names = metadata.names ?? {};
  const colors = metadata.colors ?? {};
  const icons = metadata.icons ?? {};
  const groups = {};
  for (const group of ["pinned", "hidden", "unpinned", "listed"]) {
    groups[group] = [...new Set(Array.isArray(state[group]) ? state[group] : [])].map((entry) => {
      const path = projectPath(entry);
      if (!path) return entry;
      const value = typeof entry === "string" ? { path } : { ...entry, path };
      if (value.name == null && names[path] != null) value.name = names[path];
      if (value.color == null && colors[path] != null) value.color = colors[path];
      if (value.icon == null && icons[path] != null) value.icon = icons[path];
      return Object.keys(value).length === 1 ? path : value;
    });
  }
  return groups;
};

/** Build the v1 config once, from an observed Herdr snapshot only. */
export function bootstrapConfig(observed = {}) {
  const home = validateText(observed.home ?? "/", "home must be a non-empty string");
  const localState = observed.projects?.local ?? {};
  const localMeta = {
    names: observed.names,
    colors: observed.colors,
    icons: observed.icons,
  };
  const local = {
    worktreeDirectory: observed.worktreeDirectories?.local ?? `${home.replace(/\/+$/, "")}/.herdr/worktrees`,
    locations: { chats: observed.locations?.chats ?? "~", projects: observed.locations?.projects ?? "~" },
    projects: projectGroups(localState, localMeta),
  };
  const machines = { local };
  const remoteStates = observed.projects?.remote ?? {};
  const machineEntries = Array.isArray(observed.machines)
    ? observed.machines.map((entry) => [entry?.name, entry])
    : Object.entries(observed.machines ?? {});
  for (const [name, raw] of machineEntries) {
    if (!name) continue;
    const key = machineKey(name);
    if (key === "local") continue;
    const entry = raw ?? {};
    const remoteHome = observed.machineHomes?.[key] ?? entry.home ?? "/workspaces";
    const state = remoteStates[key] ?? {};
    const metadata = {
      names: observed.remoteNames?.[key] ?? state.names,
      colors: observed.remoteColors?.[key] ?? state.colors,
      icons: observed.remoteIcons?.[key] ?? state.icons,
    };
    machines[key] = {
      worktreeDirectory: observed.worktreeDirectories?.[key] ?? entry.worktreeDirectory ?? `${String(remoteHome).replace(/\/+$/, "")}/.herdr/worktrees`,
      locations: {
        chats: observed.remoteLocations?.[key]?.chats ?? entry.locations?.chats ?? state.chats ?? "~",
        projects: observed.remoteLocations?.[key]?.projects ?? entry.locations?.projects ?? state.projects ?? "~",
      },
      projects: projectGroups(state, metadata),
      ...(state.handoffRule == null ? {} : { options: { handoffRule: state.handoffRule === true } }),
    };
  }
  return validateConfig({ version: 1, machines, repositories: clone(observed.repositories ?? {}), options: clone(observed.options ?? {}) });
}

/** Load JSON as authority; only a missing/empty file is bootstrapped. */
export async function loadConfig({ path, readTextFile, writeTextFile, observed = {} }) {
  let raw;
  try { raw = await readTextFile(path); }
  catch (error) { if (!missingFile(error)) throw error; raw = null; }
  if (typeof raw === "string" && raw.trim()) return { config: parseConfig(raw), raw, bootstrapped: false };
  const config = bootstrapConfig(observed);
  const text = serializeConfig(config);
  if (typeof writeTextFile !== "function") throw new TypeError("A writeTextFile function is required to bootstrap sidebar config");
  await writeTextFile(path, text, raw ?? null);
  return { config, raw: text, bootstrapped: true };
}

/** Save with compare-and-swap protection; callers must reload after conflicts. */
export async function saveConfig({ path, config, expected, readTextFile, writeTextFile }) {
  const text = serializeConfig(config);
  try {
    await writeTextFile(path, text, expected);
    return { ok: true, conflict: false, config, raw: text };
  } catch (error) {
    let current;
    try { current = await readTextFile(path); } catch {}
    const conflict = current !== expected || /stale|snapshot|changed|conflict/i.test(String(error?.message ?? error));
    return { ok: false, conflict, error: conflict ? "sidebar.config.json changed on disk. Reload it before saving." : String(error?.message ?? error) };
  }
}
