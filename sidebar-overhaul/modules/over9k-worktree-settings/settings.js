export const CONFIG_VERSION = 2;

// These labels are written by the visible worktree gate. They are deliberately
// namespaced so another terminal's labels can never be mistaken for setup state.
export const WORKTREE_LABELS = Object.freeze({
  repo: "over9k.worktree.repo",
  cwd: "over9k.worktree.cwd",
  status: "over9k.worktree.status",
  exitreason: "over9k.worktree.exitreason",
});

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "mksh", "yash", "csh", "tcsh", "nu", "elvish", "xonsh"]);
const SCRIPT_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "mksh", "yash", "csh", "tcsh", "node", "nodejs", "deno", "bun", "python", "python2", "python3", "ruby", "perl", "pwsh", "powershell.exe"]);
const SETUP_STATUSES = new Set(["running", "retrying", "failed", "succeeded"]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const basename = (value) => String(value ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
const errorText = (error) => String(error?.message ?? error ?? "Unknown error");

export function normalizeRoot(path) {
  if (typeof path !== "string") return "";
  const value = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = value.startsWith("/");
  const drive = /^[A-Za-z]:\//.test(value) ? value.slice(0, 3) : "";
  const rest = drive ? value.slice(3) : absolute ? value.slice(1) : value;
  const parts = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (part !== "..") parts.push(part);
  }
  const body = parts.join("/");
  if (drive) return `${drive}${body}`;
  if (absolute) return `/${body}` || "/";
  return body;
}

function absoluteRoot(path) {
  return typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path));
}

function validateArgv(argv, label, errors) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string" || !argv[0].trim() || argv.some((part) => typeof part !== "string" || part.includes("\0"))) {
    errors.push(`${label}.argv must start with a non-empty executable and contain only strings without NUL.`);
  }
}

/** Validate the v2 config accepted by worktree-hooks.js. */
export function validateConfig(config, knownMachines) {
  const errors = [];
  if (!isObject(config)) return ["config must be an object."];
  if (config.version !== CONFIG_VERSION) errors.push(`version must be ${CONFIG_VERSION}.`);
  if (!Array.isArray(config.projects)) {
    errors.push("projects must be an array.");
    return errors;
  }
  const seen = new Set();
  const machines = Array.isArray(knownMachines) ? knownMachines : null;
  for (const [projectIndex, project] of config.projects.entries()) {
    const label = `projects[${projectIndex}]`;
    if (!isObject(project)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (!has(project, "machine")) errors.push(`${label}.machine is required.`);
    const machine = project.machine;
    if (!(machine === null || (typeof machine === "string" && machine.trim().length > 0 && !machine.includes("\0")))) {
      errors.push(`${label}.machine must be null or a non-empty machine name without NUL.`);
    } else if (machines && !machines.some((entry) => (entry?.name ?? null) === machine)) {
      errors.push(`${label}.machine is not a known machine.`);
    }
    if (typeof project.repo !== "string" || !project.repo.trim() || project.repo.includes("\0") || !absoluteRoot(project.repo)) {
      errors.push(`${label}.repo must be an absolute path without NUL.`);
    } else {
      const key = `${machine ?? ""}\0${normalizeRoot(project.repo)}`;
      if (seen.has(key)) errors.push(`${label} duplicates another project for the same machine and repository.`);
      seen.add(key);
    }
    if (!isObject(project.hooks)) {
      errors.push(`${label}.hooks must be an object.`);
      continue;
    }
    for (const phase of Object.keys(project.hooks)) if (phase !== "on_created") errors.push(`${label}.hooks has unsupported phase ${phase}. Only on_created is supported.`);
    if (!Array.isArray(project.hooks.on_created)) {
      errors.push(`${label}.hooks.on_created must be an array.`);
      continue;
    }
    for (const [hookIndex, hook] of project.hooks.on_created.entries()) {
      const hookLabel = `${label}.hooks.on_created[${hookIndex}]`;
      if (!isObject(hook)) {
        errors.push(`${hookLabel} must be an object.`);
        continue;
      }
      if (typeof hook.name !== "string" || !hook.name.trim() || hook.name.includes("\0")) errors.push(`${hookLabel}.name must be a non-empty string without NUL.`);
      validateArgv(hook.argv, hookLabel, errors);
      if (!Number.isSafeInteger(hook.timeout_seconds) || hook.timeout_seconds <= 0) errors.push(`${hookLabel}.timeout_seconds must be a positive integer.`);
    }
  }
  return errors;
}

export function parseConfig(text, knownMachines) {
  if (text === null || text === undefined) return { config: { version: CONFIG_VERSION, projects: [] }, errors: [], text: null };
  let config;
  try { config = JSON.parse(text); }
  catch { return { config: null, errors: ["worktree-hooks.json is not valid JSON."], text }; }
  const errors = validateConfig(config, knownMachines);
  return { config: errors.length ? null : config, errors, text };
}

export function parseArgvText(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("argv must be a JSON array of strings, not shell command text."); }
  const errors = [];
  validateArgv(value, "command", errors);
  if (errors.length) throw new Error(errors[0]);
  return value;
}
const COMMAND_FIELDS = new Set(["name", "argv", "timeout"]);

export function commandFieldKey(index, field) {
  return Number.isSafeInteger(index) && index >= 0 && COMMAND_FIELDS.has(field) ? `cmd-${index}-${field}` : "";
}

export function commandFieldParts(key) {
  const match = /^cmd-(\d+)-(name|argv|timeout)$/.exec(String(key));
  return match ? { index: Number(match[1]), field: match[2] } : null;
}

export function updateCommandField(commands, key, value) {
  const parsed = commandFieldParts(key);
  const command = parsed && Array.isArray(commands) ? commands[parsed.index] : null;
  if (!command) return false;
  command[parsed.field] = String(value ?? "");
  return true;
}

export function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Save with the exact read snapshot as the compare-and-swap value. A failed
 * write is classified by re-reading only after the failure, never by writing a
 * backup or overwriting somebody else's edit.
 */
export async function saveConfig({ path, config, expected, readTextFile, writeTextFile }) {
  const errors = validateConfig(config);
  if (errors.length) return { ok: false, conflict: false, error: `Invalid worktree hooks config: ${errors.join(" ")}` };
  const text = serializeConfig(config);
  try {
    await writeTextFile(path, text, expected);
    return { ok: true, conflict: false, text };
  } catch (error) {
    let current;
    try { current = await readTextFile(path); } catch {}
    const conflict = current !== expected || /stale|snapshot|changed|conflict/i.test(errorText(error));
    return {
      ok: false,
      conflict,
      error: conflict ? "worktree-hooks.json changed on disk. Reload it before saving." : `Could not save worktree-hooks.json: ${errorText(error)}`,
    };
  }
}

function scriptOperand(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return null;
  const executable = basename(argv[0]).toLowerCase();
  if (!SCRIPT_INTERPRETERS.has(executable)) return null;
  for (let i = 1; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === "-c" || word === "--command") return null;
    if (typeof word !== "string" || word.startsWith("-")) continue;
    if (word.startsWith("/") || word.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(word)) return word;
    return null;
  }
  return null;
}

async function shellCheck(execFn, args, on) {
  try {
    const result = await execFn("sh", args, { on });
    return { ok: result?.code === 0, detail: result?.code === 0 ? "available" : (result?.stderr || result?.stdout || "not available").trim() || "not available" };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}

/**
 * Check only whether the selected machine can see the root, executable and an
 * explicit script operand. It never invokes a configured hook.
 */
export async function availabilityChecks(project, execFn) {
  const on = project?.machine ?? null;
  const root = await shellCheck(execFn, ["-c", 'test -d "$1"', "worktree-hooks", project?.repo ?? ""], on);
  const commands = [];
  for (const hook of project?.hooks?.on_created ?? []) {
    const executable = await shellCheck(execFn, ["-c", 'command -v "$1"', "worktree-hooks", hook.argv?.[0] ?? ""], on);
    const operand = scriptOperand(hook.argv);
    const script = operand === null
      ? null
      : await shellCheck(execFn, ["-c", 'case "$1" in "~") set -- "$HOME" ;; "~/"*) set -- "$HOME/${1#~/}" ;; esac; test -f "$1"', "worktree-hooks", operand], on);
    commands.push({ name: hook.name, executable, script, script_operand: operand });
  }
  return {
    ok: root.ok && commands.every((command) => command.executable.ok && (command.script === null || command.script.ok)),
    root,
    commands,
    checked_only: true,
  };
}

function setupLabels(term) {
  return term?.labels && typeof term.labels === "object" ? term.labels : {};
}

function matchesSetup(term, expected) {
  const labels = setupLabels(term);
  return normalizeRoot(labels[WORKTREE_LABELS.repo]) === normalizeRoot(expected?.repo)
    && normalizeRoot(labels[WORKTREE_LABELS.cwd]) === normalizeRoot(expected?.cwd)
    && SETUP_STATUSES.has(labels[WORKTREE_LABELS.status]);
}

/** Pick an exact setup result, preferring the newest active or completed result. */
export function selectSetupResult(terms, expected) {
  const rows = (Array.isArray(terms) ? terms : []).filter((term) => matchesSetup(term, expected));
  const active = rows.filter((term) => ["running", "retrying"].includes(setupLabels(term)[WORKTREE_LABELS.status]));
  const candidates = active.length ? active : rows;
  const rank = { running: 2, retrying: 1, failed: 1, succeeded: 1 };
  return candidates.sort((a, b) => {
    const timeA = Number(a?.created_ms ?? 0) || 0;
    const timeB = Number(b?.created_ms ?? 0) || 0;
    if (timeB !== timeA) return timeB - timeA;
    const labelsA = setupLabels(a), labelsB = setupLabels(b);
    return (rank[labelsB[WORKTREE_LABELS.status]] ?? 0) - (rank[labelsA[WORKTREE_LABELS.status]] ?? 0);
  })[0] ?? null;
}

function isShellArgv(argv) {
  const name = basename(argv?.[0]).replace(/^-/, "").toLowerCase();
  return SHELLS.has(name);
}

/**
 * A retry is safe only for the exact failed gate whose own terminal shell is
 * still foreground. In particular, an editor, agent or nested command rejects.
 */
export function retryGuard(term, expected) {
  if (!term) return { ok: false, reason: "The setup terminal is no longer available." };
  if (term.state !== "live") return { ok: false, reason: "The setup terminal has ended." };
  const labels = setupLabels(term);
  if (normalizeRoot(labels[WORKTREE_LABELS.repo]) !== normalizeRoot(expected?.repo) || normalizeRoot(labels[WORKTREE_LABELS.cwd]) !== normalizeRoot(expected?.cwd)) {
    return { ok: false, reason: "That terminal belongs to a different checkout." };
  }
  if (labels[WORKTREE_LABELS.status] !== "failed") return { ok: false, reason: "Setup is not waiting for a retry." };
  const foreground = term.foreground;
  if (!foreground || !isShellArgv(foreground.argv)) return { ok: false, reason: "The terminal is busy with another program." };
  if (foreground.pid && term.pid && foreground.pid !== term.pid) return { ok: false, reason: "The terminal is busy with another program." };
  return { ok: true, reason: "" };
}
