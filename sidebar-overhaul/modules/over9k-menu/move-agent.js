import { migrateAgent } from "./migrate-agent.js";

const WORKTREE_SCAN = `root="$1"
case "$root" in
  "~") root="$HOME" ;;
  "~/"*) root="$HOME/\${root#~/}" ;;
esac
{
  git -c credential.interactive=false -C "$root" worktree list --porcelain 2>/dev/null
  find "$root" -mindepth 2 -maxdepth 3 -type d -name .git -print 2>/dev/null | while read -r gitdir; do
    git -c credential.interactive=false -C "\${gitdir%/.git}" worktree list --porcelain 2>/dev/null
  done
} | awk '/^worktree / { sub(/^worktree /, ""); print }' | while read -r folder; do
  [ -d "$folder" ] && printf '%s\n' "$folder"
done | sort -u`;

export const normalizeFolder = (folder) => String(folder ?? "").replace(/\\/g, "/").replace(/\/+$/, "") || "/";

const folderKey = (machine, folder) => `${machine ?? ""}\\0${normalizeFolder(folder)}`;

const worktreeName = (folder) => normalizeFolder(folder).split("/").filter(Boolean).pop() || folder;
export function reopenCandidates({ machine = null, recent = [], parked = [], scanned = [], open = [] }) {
  const opened = new Set(open.filter(s => (s.machine ?? null) === machine).map(s => normalizeFolder(s.folder)));
  const entries = new Map();
  const add = (entry, source) => {
    const raw = typeof entry === "string" ? entry : entry?.folder ?? entry?.dir;
    if (!raw) return;
    const folder = normalizeFolder(raw);
    if (!folder || opened.has(folder)) return;
    const current = entries.get(folder);
    if (current) {
      if (!current.sources.includes(source)) current.sources.push(source);
      return;
    }
    entries.set(folder, { folder, name: (typeof entry === "object" && entry.name) || worktreeName(folder), sources: [source] });
  };
  for (const entry of recent) if (!entry.machine || entry.machine === machine) add(entry, "Recent");
  for (const entry of parked) add(entry, "Parked");
  for (const entry of scanned) add(entry, "Workspace");
  return [...entries.values()];
}


export async function discoverWorktrees(machine, { exec, root = "~" }) {
  const value = String(root);
  if (value.includes(String.fromCharCode(10)) || value.includes(String.fromCharCode(13)) || value.includes(String.fromCharCode(0))) throw new Error("The workspace path contains unsupported control characters.");
  const result = await exec("sh", ["-c", WORKTREE_SCAN, "sh", value], machine ? { on: machine } : {});
  if (result?.code !== 0) throw new Error(result?.stderr || result?.stdout || "Git worktree discovery failed.");
  const folders = [...new Set(String(result?.stdout ?? "").split("\n").flatMap(line => line.trim().replace(/^worktree\s+/, "")).map(line => normalizeFolder(line)).filter((folder) => folder && folder !== "/"))];
  return folders.map((folder) => ({ id: `worktree:${machine ?? "local"}:${folder}`, machine: machine ?? null, folder, name: worktreeName(folder), discovered: true }));
}

function mergeTargets(targets, discovered, { machine, omp, owner }) {
  const result = [];
  const seen = new Set();
  for (const target of [...targets, ...discovered]) {
    if (!target?.folder || (!omp && (target.machine ?? null) !== machine)) continue;
    const folder = normalizeFolder(target.folder);
    if (!folder || target.id === owner?.id || folderKey(target.machine ?? null, folder) === folderKey(owner?.machine ?? null, owner?.folder)) continue;
    const key = folderKey(target.machine ?? null, folder);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...target, folder });
  }
  return result;
}

export function moveTargets(terminal, { spaces, panes, agents, terminals, discovered = [] }) {
  const agent = agents.find(a => a.address === terminal);
  const pane = panes.find(p => p.terminal === terminal);
  const owner = spaces.find(s => s.id === agent?.space || (s.tabs ?? []).some(t => t.id === pane?.tab));
  const machine = owner?.machine ?? (terminal.includes("/") ? terminal.split("/")[0] : null);
  const term = terminals.find(t => t.address === terminal);
  const omp = agent?.app === "omp" || agent?.program?.key === "omp" || term?.agent === "omp";
  const actual = spaces.filter(s => (omp || (s.machine ?? null) === machine) && s.id !== owner?.id).map(s => ({
    ...s,
    folder: panes.find(p => (s.tabs ?? []).some(t => t.id === p.tab) && p.cwd)?.cwd || s.folder,
  }));
  const ownerFolder = panes.find(p => (owner?.tabs ?? []).some(t => t.id === p.tab) && p.cwd)?.cwd || owner?.folder;
  return mergeTargets(actual, discovered, { machine, omp, owner: owner && { ...owner, folder: ownerFolder } });
}

export async function moveAgent(terminal, destinationId, io) {
  const state = io.snapshot();
  const target = moveTargets(terminal, state).find(s => s.id === destinationId);
  if (!target) throw new Error("Choose an available destination space.");
  const agent = state.agents.find(a => a.address === terminal);
  const term = state.terminals.find(t => t.address === terminal);
  if (!agent || term?.state !== "live") throw new Error("This agent is no longer running.");
  const omp = agent.app === "omp" || agent.program?.key === "omp" || term.agent === "omp";
  if (agent.status === "working" || agent.status === "blocked") throw new Error("Wait for the agent to finish and close any prompt before moving it.");
  if (/[\r\n\0]/.test(target.folder)) throw new Error("The destination path contains unsupported control characters.");
  const sourceMachine = terminal.includes("/") ? terminal.split("/")[0] : null;
  if ((target.machine ?? null) !== sourceMachine) {
    if (!omp) throw new Error("Only OMP sessions support moves between machines.");
    return migrateAgent(terminal, target, io);
  }
  const command = async (cmd, args) => {
    const result = await io.exec(cmd, args);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `${cmd} failed`);
    return result;
  };
  const app = async (name, args) => {
    const result = await command("herdr-app", ["do", name, JSON.stringify(args)]);
    const data = JSON.parse(result.stdout || "{}");
    if (data.error) throw new Error(data.error);
    return data;
  };
  const until = async (predicate, message) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await io.sleep(100);
    }
    throw new Error(message);
  };
  // Confirm OMP accepted /move before changing terminal ownership. A rejected
  // command must leave the terminal in its original space.
  if (omp) {
    const keys = [...`/move ${target.folder}`].map(c => c === " " ? "space" : c);
    await command("hc", ["keys", terminal, ...keys, "enter", "enter"]);
    await until(async () => {
      const result = await command("hc", ["get", terminal]);
      const current = JSON.parse(result.stdout);
      return (current.foreground?.cwd ?? current.cwd)?.replace(/\/$/, "") === target.folder.replace(/\/$/, "");
    }, "OMP has not confirmed the directory change. Its terminal was not moved; inspect its prompt.");
  }
  await app("terminal.park", { terminal });
  await until(() => !io.snapshot().panes.some(p => p.terminal === terminal), "The terminal could not be parked. It was not killed.");
  try {
    await app("space.select", { id: target.id });
    await app("terminal.keep", { terminal });
    await until(() => {
      const now = io.snapshot();
      const space = now.spaces.find(s => s.id === target.id);
      return now.panes.some(p => p.terminal === terminal && (space?.tabs ?? []).some(t => t.id === p.tab));
    }, "The terminal is still running but its destination pane has not appeared.");
  } catch (error) {
    throw new Error(`${error.message} The running terminal can be recovered with terminal.keep.`);
  }
}
