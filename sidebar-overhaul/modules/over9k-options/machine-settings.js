import { lookupMachineOption } from "../../config.js";
const localKey = (machine) => machine == null ? "local" : machine;

function machineOption(config, machine, key) {
  return lookupMachineOption(config, machine, key, false) === true;
}
const absolute = (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
function values(config, machine, home) {
  const entry = config?.machines?.[localKey(machine)];
  return {
    worktreeDirectory: entry?.worktreeDirectory ?? (machine == null ? `${String(home ?? "").replace(/\/+$/, "")}/.herdr/worktrees` : ""),
    chats: entry?.locations?.chats ?? "~",
    projects: entry?.locations?.projects ?? "~",
    keepUpToDate: machineOption(config, machine, "keepUpToDate"),
    handoffRule: machineOption(config, machine, "handoffRule"),
  };
}

function validatePath(path, { root = false } = {}) {
  if (typeof path !== "string" || !path.trim()) throw new Error(root ? "Enter an absolute worktree root." : "Enter an absolute folder path or ~ shorthand.");
  const value = path.trim();
  if (/[\u0000-\u001f\u007f]/.test(value) || value.split(/[\\/]/).includes("..")) throw new Error("Paths cannot contain control characters or .. segments.");
  if (root ? (!absolute(value) || value.includes("~") || /[{}]/.test(value)) : (!absolute(value) && value !== "~" && !value.startsWith("~/"))) {
    throw new Error(root ? "Worktree root must be an absolute path (not ~ or a template)." : "Folder must be absolute or use ~ / ~/… shorthand.");
  }
  return value;
}


async function directoryCheck(exec, machine, path, writable = false) {
  const command = writable
    ? 'case "$1" in "~") d=$HOME ;; "~/"*) d="$HOME/${1#~/}" ;; *) d=$1 ;; esac; test -d "$d" && test -w "$d" && test -x "$d"'
    : 'case "$1" in "~") d=$HOME ;; "~/"*) d="$HOME/${1#~/}" ;; *) d=$1 ;; esac; test -d "$d"';
  const result = await exec("sh", ["-c", command, "sh", path], machine == null ? {} : { on: machine }).catch(() => null);
  return result?.code === 0;
}

export class MachineSettingsController {
  constructor({ config = null, machines = [], home = "", machine = null } = {}) {
    this.config = config;
    this.machines = machines;
    this.home = home;
    this.machine = machine ?? null;
    this.drafts = new Map();
    this.error = "";
  }

  setConfig(config) { this.config = config; }
  setMachines(machines) { this.machines = machines ?? []; }

  knownMachines() {
    const names = new Set(["local"]);
    for (const machine of this.machines ?? []) if (machine?.name) names.add(machine.name);
    for (const name of Object.keys(this.config?.machines ?? {})) names.add(name);
    return [null, ...[...names].filter((name) => name !== "local").sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))];
  }

  connected(machine = this.machine) {
    return machine == null || this.machines.some((entry) => entry?.name === machine && entry.state === "connected");
  }

  draft(machine = this.machine) {
    const key = localKey(machine);
    if (!this.drafts.has(key)) {
      const base = values(this.config, machine, this.home);
      this.drafts.set(key, { base, value: { ...base } });
    }
    return this.drafts.get(key).value;
  }

  dirty(machine = this.machine) {
    const entry = this.drafts.get(localKey(machine));
    return Boolean(entry && JSON.stringify(entry.base) !== JSON.stringify(entry.value));
  }

  changed(machine = this.machine) {
    const entry = this.drafts.get(localKey(machine));
    if (!entry) return [];
    return Object.keys(entry.value).filter((key) => entry.base[key] !== entry.value[key]);
  }
  dirtyMachines() {
    return this.knownMachines().filter((machine) => this.dirty(machine));
  }

  dirtyAny() {
    return this.dirtyMachines().length > 0;
  }

  set(key, value, machine = this.machine) {
    if (!Object.hasOwn(values(this.config, machine, this.home), key)) return;
    this.draft(machine)[key] = value;
    this.error = "";
  }

  discard(machine = this.machine) {
    this.drafts.delete(localKey(machine));
    this.error = "";
  }

  async save({ persist, exec, machines = this.machines } = {}) {
    const machine = this.machine;
    const draft = { ...this.draft(machine) };
    const changed = this.changed(machine);
    this.error = "";
    if (!changed.length) return null;
    try {
      const entryExists = Boolean(this.config?.machines?.[localKey(machine)]);
      if (!entryExists) draft.worktreeDirectory = validatePath(draft.worktreeDirectory, { root: true });
      else for (const key of changed) if (["worktreeDirectory", "chats", "projects"].includes(key)) draft[key] = validatePath(draft[key], { root: key === "worktreeDirectory" });
      const connected = machine == null || (machines ?? []).some((entry) => entry?.name === machine && entry.state === "connected");
      if (!connected) {
        for (const key of ["chats", "projects"]) {
          if ((!entryExists || changed.includes(key)) && changed.includes(key) && !absolute(draft[key])) throw new Error(`Reconnect ${machine} or enter an absolute ${key} path; saved ~ paths are preserved while offline.`);
        }
      } else {
        if ((!entryExists || changed.includes("worktreeDirectory")) && !await directoryCheck(exec, machine, draft.worktreeDirectory, true)) throw new Error(`Worktree root must already exist and be writable on ${machine ?? "this computer"}.`);
        for (const key of ["chats", "projects"]) {
          if ((!entryExists || changed.includes(key)) && !await directoryCheck(exec, machine, draft[key])) throw new Error(`${key === "chats" ? "Chats" : "Projects"} folder does not exist on ${machine ?? "this computer"}.`);
        }
      }
      const result = await persist((config) => {
        const key = localKey(machine);
        const entry = config.machines[key] ?? { worktreeDirectory: draft.worktreeDirectory, locations: {}, projects: { pinned: [], hidden: [], unpinned: [], listed: [] } };
        entry.locations ??= {};
        for (const location of ["chats", "projects"]) if (changed.includes(location)) entry.locations[location] = draft[location];
        if (changed.includes("worktreeDirectory")) entry.worktreeDirectory = draft.worktreeDirectory;
        entry.options ??= {};
        for (const option of ["keepUpToDate", "handoffRule"]) if (changed.includes(option)) entry.options[option] = draft[option] === true;
        config.machines[key] = entry;
        return config;
      });
      this.config = result?.config ?? result;
      this.drafts.delete(localKey(machine));
      return result;
    } catch (error) {
      this.error = String(error?.message ?? error);
      throw error;
    }
  }
}
