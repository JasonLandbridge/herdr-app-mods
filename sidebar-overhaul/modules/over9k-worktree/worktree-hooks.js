import { flatDestination, hasDestinationCollision, machineKey } from "../../config.js";

const CONFIG_VERSION = 2;

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

const invalid = (message) => ({ hooks: [], matched: false, error: `Invalid worktree hooks config: ${message}` });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function configuredDestination(config, machine, repo, branch) {
  const key = machineKey(machine);
  const base = config?.machines?.[key]?.worktreeDirectory;
  if (typeof base !== "string") return { error: `No worktree root is configured for machine ${key}.` };
  try { return { path: flatDestination(base, repo, branch) }; }
  catch (error) { return { error: `Invalid worktree root for machine ${key}: ${String(error?.message ?? error)}` }; }
}

function matchingProject(project, machine, main) {
  return isObject(project)
    && Object.prototype.hasOwnProperty.call(project, "machine")
    && project.machine === (machine ?? null)
    && typeof project.repo === "string"
    && normalizeRoot(project.repo) === normalizeRoot(main);
}

export function hookPlan(text, machine, main) {
  if (text === null || text === undefined) return { hooks: [], matched: false };
  let config;
  try { config = JSON.parse(text); }
  catch { return invalid("worktree-hooks.json is not valid JSON."); }
  if (!isObject(config) || config.version !== CONFIG_VERSION) return invalid(`expected version ${CONFIG_VERSION}.`);
  if (!Array.isArray(config.projects)) return invalid("projects must be an array.");
  const matches = config.projects.filter((project) => matchingProject(project, machine, main));
  if (matches.length === 0) return { hooks: [], matched: false };
  if (matches.length > 1) return invalid("multiple projects match the same machine and repository.");
  const project = matches[0];
  if (project.hooks === undefined) return invalid("the matching project must define hooks.");
  if (!isObject(project.hooks)) return invalid("hooks must be an object.");
  const phases = Object.keys(project.hooks).filter((phase) => phase !== "on_created");
  if (phases.length) return invalid(`unsupported hook phase: ${phases[0]}. Only on_created is supported.`);
  if (!Array.isArray(project.hooks.on_created)) return invalid("hooks.on_created must be an array.");
  const hooks = [];
  for (const [index, hook] of project.hooks.on_created.entries()) {
    if (!isObject(hook)) return invalid(`hooks.on_created[${index}] must be an object.`);
    if (typeof hook.name !== "string" || !hook.name.trim() || hook.name.includes("\0")) return invalid(`hooks.on_created[${index}].name must be a non-empty string without NUL.`);
    if (!Array.isArray(hook.argv) || hook.argv.length === 0 || typeof hook.argv[0] !== "string" || hook.argv[0].length === 0 || hook.argv.some((part) => typeof part !== "string" || part.includes("\0")))
      return invalid(`hooks.on_created[${index}].argv must start with a non-empty executable and contain only strings.`);
    if (!Number.isSafeInteger(hook.timeout_seconds) || hook.timeout_seconds <= 0)
      return invalid(`hooks.on_created[${index}].timeout_seconds must be a positive integer.`);
    hooks.push({ name: hook.name, argv: [...hook.argv], timeout_seconds: hook.timeout_seconds });
  }
  return { hooks, matched: true };
}

export function shellQuote(value) {
  const text = String(value);
  if (text.includes("\0")) throw new Error("argv cannot contain NUL.");
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

const RETRY_COMMAND = 'sh -c "$HERDR_WORKTREE_GATE"';
export const WORKTREE_LABELS = Object.freeze({
  repo: "over9k.worktree.repo",
  cwd: "over9k.worktree.cwd",
  status: "over9k.worktree.status",
  exitreason: "over9k.worktree.exitreason",
});

function labelSetupLines(metadata) {
  if (!metadata || typeof metadata.repo !== "string" || typeof metadata.cwd !== "string") return [];
  const repo = shellQuote(`${WORKTREE_LABELS.repo}=${metadata.repo}`);
  const cwd = shellQuote(`${WORKTREE_LABELS.cwd}=${metadata.cwd}`);
  return [
    "label_gate() {",
    "  [ -n \"${HC_TERMINAL_ID:-}\" ] || return 0",
    `  hc label "$HC_TERMINAL_ID" ${repo} ${cwd} "${WORKTREE_LABELS.status}=$1" "${WORKTREE_LABELS.exitreason}=$2" >/dev/null 2>&1 || true`,
    "}",
  ];
}

function labelGate(status, reason) {
  return `label_gate ${shellQuote(status)} ${shellQuote(reason)}`;
}

function hookSetupLines(hooks, metadata) {
  const labels = labelSetupLines(metadata);
  const lines = [
    ...labels,
    "hook_name=",
    "hook_timeout=",
    "hook_status=0",
    "run_hook() {",
    "  hook_name=$1",
    "  hook_timeout=$2",
    "  shift 2",
    "  printf '\\n[worktree] Running hook: %s (timeout %ss)\\n' \"$hook_name\" \"$hook_timeout\"",
    "  timeout --foreground \"$hook_timeout\" \"$@\"",
    "}",
    "run_hooks() {",
  ];
  for (const hook of hooks) {
    const invocation = [hook.name, hook.timeout_seconds, ...hook.argv].map(shellQuote).join(" ");
    const retry = hook.argv.map(shellQuote).join(" ");
    lines.push(`  run_hook ${invocation}`);
    lines.push("  hook_status=$?");
    lines.push("  if [ \"$hook_status\" -ne 0 ]; then");
    lines.push("    if [ \"$hook_status\" -eq 124 ]; then");
    if (labels.length) lines.push(`      ${labelGate("failed", "timeout")}`);
    lines.push("      printf '[worktree] Hook failed because it timed out (exit code %s).\\n' \"$hook_status\"");
    lines.push("    else");
    if (labels.length) lines.push(`      label_gate 'failed' "hook_exit_$hook_status"`);
    lines.push("      printf '[worktree] Hook failed with exit code %s: %s\\n' \"$hook_status\" \"$hook_name\"");
    lines.push("    fi");
    lines.push(`    printf '%s\\n' ${shellQuote(`Failed hook command: ${retry}`)}`);
    lines.push("    printf '%s\\n' 'Retry setup in this terminal:'");
    lines.push(`    printf '%s\\n' ${shellQuote(RETRY_COMMAND)}`);
    lines.push("    printf '%s\\n' 'The checkout was kept. The requested program was not started.'");
    lines.push("    return 1");
    lines.push("  fi");
  }
  lines.push("  return 0");
  lines.push("}");
  return lines;
}

function completionLines(requestedArgv, metadata) {
  const lines = [];
  if (labelSetupLines(metadata).length) lines.push(labelGate("succeeded", "success"));
  lines.push("printf '%s\\n' '[worktree] All hooks succeeded.'");
  if (Array.isArray(requestedArgv) && requestedArgv.length > 0) lines.push(`exec ${requestedArgv.map(shellQuote).join(" ")}`);
  else lines.push("exec \"${SHELL:-sh}\"");
  return lines;
}

export function hookGateRetryScript(hooks, requestedArgv, metadata) {
  const labels = labelSetupLines(metadata);
  return [
    ...hookSetupLines(hooks, metadata),
    ...(labels.length ? [labelGate("retrying", "manual_retry")] : []),
    "if ! run_hooks; then",
    "  exit 125",
    "fi",
    ...completionLines(requestedArgv, metadata),
  ].join("\n");
}

export function hookGateScript(hooks, requestedArgv, metadata) {
  const labels = labelSetupLines(metadata);
  const retryScript = hookGateRetryScript(hooks, requestedArgv, metadata);
  return [
    `export HERDR_WORKTREE_GATE=${shellQuote(retryScript)}`,
    ...hookSetupLines(hooks, metadata),
    ...(labels.length ? [labelGate("running", "started")] : []),
    "if ! run_hooks; then",
    "  printf '%s\\n' 'A shell is left open in the checkout for inspection or retry.'",
    "  exec \"${SHELL:-sh}\"",
    "fi",
    ...completionLines(requestedArgv, metadata),
  ].join("\n");
}

export function hookGateArgv(hooks, requestedArgv, metadata) {
  if (!hooks?.length) return requestedArgv;
  return ["sh", "-c", hookGateScript(hooks, requestedArgv, metadata), "herdr-worktree-hook-gate"];
}

const branchSlug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

export async function createWorktree({ branch, repo, machine, config, existingDestinations, pathExists, tab, requestedArgv, git, readHooks, runSpace }) {
  if (!branch) return "Type a branch name.";
  const destination = configuredDestination(config, machine, repo.main, branch);
  if (destination.error) return destination.error;
  const path = destination.path;
  if (hasDestinationCollision(path, existingDestinations)) return `Worktree destination already exists: ${path}`;
  if (pathExists && await pathExists(path)) return `Worktree destination already exists: ${path}`;
  const hookPlan = await readHooks({ machine: machine ?? null, main: repo.main });
  if (hookPlan.error) return hookPlan.error;
  const launchArgv = hookGateArgv(hookPlan.hooks, requestedArgv, { repo: repo.main, cwd: path });
  const exists = (await git(repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], machine)).ok;
  const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
  const result = await git(repo.top, add, machine, 600_000);
  if (!result.ok) return result.err || "git worktree add failed.";
  runSpace({ folder: path, machine: machine ?? "", tab, argv: launchArgv });
  return "";
}
