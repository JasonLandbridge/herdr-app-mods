// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "agent" | "tab" | "space" | "project" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { plan } from "./close-plan.js";
import { agentTask } from "./agent-name.js";
import { moveAgent, moveTargets, discoverWorktrees, normalizeFolder, reopenCandidates } from "./move-agent.js";
import { run, closeOverlay, openOverlay, theme, themes, keys, terminals, spaces, panes, agents, machines, exec, home, pickFolder, shared, setShared } from "herdr";
import { lookupLocation } from "../../config.js";
import { currentSidebarConfig } from "../../config-store.js";
const VISIBILITY_ACTIONS = "herdr-custom.agentVisibility.actions";
function queueVisibility(type, payload = {}) {
  const current = Array.isArray(shared(VISIBILITY_ACTIONS)) ? shared(VISIBILITY_ACTIONS) : [];
  setShared(VISIBILITY_ACTIONS, [...current, { type, ...payload, id: `${Date.now()}-${current.length}` }]);
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s?.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s?.folder;
}
async function recentMoveTargets() {
  const result = await exec("herdr-app", ["ls"]).catch(() => null);
  if (!result || result.code !== 0) return [];
  let snapshot;
  try { snapshot = JSON.parse(result.stdout || "{}"); } catch { return []; }
  const folders = (machine) => {
    const mine = machine ? shared("projects.on")?.[machine] ?? {} : null;
    return machine
      ? [...(mine.pinned ?? []), ...(mine.unpinned ?? []), ...(mine.hidden ?? []), ...(shared("projects.autoOn")?.[machine] ?? [])]
      : [...(shared("projects.pinned") ?? []), ...(shared("projects.listed") ?? []), ...(shared("projects.hidden") ?? []), ...(shared("projects.unpinned") ?? []), ...(shared("projects.auto") ?? [])];
  };
  const machinesToLoad = [null, ...(machines() ?? []).map(machine => machine?.name).filter(Boolean)];
  const targets = [];
  for (const machine of machinesToLoad) {
    const candidates = reopenCandidates({ machine, recent: snapshot.recent ?? [], parked: folders(machine), open: spaces() });
    for (const candidate of candidates) {
      const exists = await exec("test", ["-d", candidate.folder], machine ? { on: machine } : {}).catch(() => null);
      if (exists?.code !== 0) continue;
      targets.push({ ...candidate, id: `recent-parked:${machine ?? "local"}:${normalizeFolder(candidate.folder)}`, machine, discovered: true });
    }
  }
  return targets;
}
function tildePath(path, machine) {
  const value = String(path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r") || value.split("/").includes("..")) return null;
  if (value === "~" || value.startsWith("~/") || value.startsWith("/")) return value;
  return null;
}

function workspaceRoot(machine = null) {
  const options = shared("sidebar.options") ?? {};
  return lookupLocation(currentSidebarConfig(), machine, "projects", (machine
    ? options.computers?.[machine]?.projects || shared("over9k.remoteLocations")?.[machine]?.projects
    : options.locations?.projects || shared("over9k.locations")?.projects) || "~");
}

function expandPath(path, homeDir) {
  const value = String(path ?? "");
  return value === "~" ? homeDir : value.startsWith("~/") ? `${homeDir}${value.slice(1)}` : value;
}

function pathUnder(root, folder, homeDir = home()) {
  const base = normalizeFolder(expandPath(root, homeDir));
  const target = normalizeFolder(expandPath(folder, homeDir));
  return target === base || target.startsWith(`${base}/`);
}


async function machineHome(machine) {
  if (!machine) return home();
  const shell = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine }).catch(() => null);
  if (shell?.code === 0 && shell.stdout.trim()) return shell.stdout.trim().replace(/\\/g, "/");
  const powershell = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: machine }).catch(() => null);
  if (powershell?.code === 0 && powershell.stdout.trim()) return powershell.stdout.trim().replace(/\\/g, "/");
  throw new Error(`Could not resolve the home folder on ${machine}.`);
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// Rename a pane: an agent's session by its own command (so its title, Herdr's
// rows and its resume lists all follow), a plain terminal's tab. over9k-rename
// asks for the name.
function renamePane({ pane, terminal }) {
  const p = panes().find((x) => x.pane === pane);
  const a = agents().find((x) => x.address === terminal);
  const tab = spaces().flatMap((s) => s.tabs ?? []).find((t) => t.id === p?.tab);
  const named = tab && !/^(\d+|tb?[0-9a-z]+)$/.test(tab.name) && tab.name !== (a ?? p)?.program?.name ? tab.name : "";
  // What the sidebar shows: a name given to its tab, else the conversation's.
  const value = named || (a ? agentTask(a, p?.cwd) : "");
  openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 380, height: 200,
    props: { pane, terminal, tab: tab?.id, alone: panes().filter((x) => x.tab === p?.tab).length === 1, value, title: a ? `Rename ${a.program?.name ?? "agent"} session` : "Rename terminal" } });
}


function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "machine":
      return [["Machine settings…", "machine.settings", { machine: tg.machine ?? null }]];
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const paneAgent = agents().some((a) => a.address === tg.terminal)
        || Boolean(term?.program?.agent || /^(claude|codex|pi|opencode|gemini|aider|amp|cursor)/i.test(term?.agent ?? ""));
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ["Rename", "pane.rename", { pane: tg.pane, terminal: tg.terminal }],
        ...(paneAgent ? [["Hide agent", "visibility.hide", { addresses: [tg.terminal] }]] : []),
        ...(paneAgent ? [["Move to space…", "agent.move", { terminal: tg.terminal }]] : []),
        // An agent's work to a space of its own (over9k-handoff).
        ...(agents().some((a) => a.address === tg.terminal) ? [["Hand off\u2026", "pane.handoff", { terminal: tg.terminal }]] : []),
        ...copyItem(paneAt(tg.pane)?.folder),
        ...folderItem(paneAt(tg.pane)),
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ["Close pane", "close-ask", { panes: [tg.pane] }],
      ];
    }
    case "agent": {
      const pane = panes().find((x) => x.terminal === tg.terminal && x.cwd);
      const term = terminals().find((x) => x.address === tg.terminal && x.state === "live" && x.cwd);
      return [
        ["Copy agent ID", "agent.copy-id", { id: tg.terminal }],
        ...copyItem(pane?.cwd ?? term?.cwd),
        ["Move to space…", "agent.move", { terminal: tg.terminal }],
        ["Hide agent", "visibility.hide", { addresses: [tg.terminal] }],
      ];
    }
    case "hidden": {
      const hidden = p.hidden ?? tg;
      if (hidden?.kind === "agent") return [
        ...(hidden.address ? [["Copy agent ID", "agent.copy-id", { id: hidden.address }]] : []),
        ["Close and remove…", "close-ask", { hidden }],
      ];
      return hidden?.kind === "group" ? [["Close and remove…", "close-ask", { hidden }]] : [];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ...folderItem(paneAt(panes().find((p) => p.tab === tg.id)?.pane)),
        ["Close", "close-ask", { tabs: [tg.id] }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ...copyItem(place(spaces().find((s) => s.id === tg.id))),
        ...folderItem(spaces().find((s) => s.id === tg.id)),
        ...listItems(spaces().find((s) => s.id === tg.id)?.folder),
        ...(tg.group ? [["Hide project/space", "visibility.hide-group", { group: tg.group }]] : []),
        ["Close", "close-ask", { spaces: [tg.id] }],
      ];
    // Rows picked in over9k (Shift/Cmd/Ctrl+click): close them all, or
    // unpin the projects among them.
    case "selection": {
      const closing = plan({ spaces: tg.spaces, panes: tg.panes });
      const { group, separate } = paneMoves(tg.panes ?? []);
      return [
        ...(group ? [["Group into one tab", "panes.group", group]] : []),
        ...(separate ? [["Separate into tabs", "panes.separate", separate]] : []),
        // Agent sub-rows travel with the consent plan and are published only
        // after confirmation, never before this dialog opens.
        ...(closing.commands.length || tg.subs?.length ? [["Close selected", "close-many", { spaces: tg.spaces, panes: tg.panes, subs: tg.subs }]] : []),
        ...(tg.folders?.length ? [["Unpin selected", "list.unpin-many", { folders: tg.folders }]] : []),
      ];
    }
    // A project or folder row with no space (over9k): open it, keep it listed or not.
    case "project":
      return [
        ["Open", "project.open", { folder: tg.folder, name: tg.name, ...(tg.machine ? { machine: tg.machine } : {}) }],
        ["Rename", "project.rename", { folder: tg.folder, name: tg.name, machine: tg.machine ?? null }],
        ...folderItem(tg),
        ...listItems(tg.folder, tg.machine ?? null),
        ...(tg.group ? [["Hide project/space", "visibility.hide-group", { group: tg.group }]] : []),
      ];
    default:
      return [
        ["New space", "space.new", { argv: ["bash", "-lc", "exec omp"] }],
        ["Keybinds", "app.help", {}],
        // The themes Herdr has (its own and any added in themes/), as many as fit.
        ...themes().slice(0, 5).map((x) => [`Theme: ${x.name.replace(/-/g, " ")}`, "app.theme", { name: x.name }]),
      ];
  }
}

// Whether a folder stays in the sidebar's project list (over9k reads
// these from shared state): ~/Code repos and agent-set-up folders are listed
// (pinned by default) until unpinned; any other folder once pinned.
// Another computer's lists (machine): shared "projects.on"[machine], its
// found projects "projects.autoOn"[machine] (over9k keeps both).
function lists(machine) {
  if (!machine) return { pinned: shared("projects.pinned") ?? [], hidden: shared("projects.hidden") ?? [], unpinned: shared("projects.unpinned") ?? [], auto: shared("projects.auto") ?? [] };
  const on = shared("projects.on")?.[machine] ?? {};
  return { pinned: on.pinned ?? [], hidden: on.hidden ?? [], unpinned: on.unpinned ?? [], auto: shared("projects.autoOn")?.[machine] ?? [] };
}

// The folder in the file manager (this computer's only).
// Where a pane's terminal is: its folder, and the computer (null: this one).
function paneAt(pane) {
  const p = pane && panes().find((x) => x.pane === pane);
  const sp = p && spaces().find((s) => (s.tabs ?? []).some((t) => t.id === p.tab));
  return p?.cwd ? { folder: p.cwd, machine: sp?.machine ?? null } : null;
}
function copyItem(folder) {
  return folder ? [["Copy folder path", "folder.copy", { folder }]] : [];
}

function folderItem(at) {
  return at?.folder && !at.machine ? [["Open folder", "folder.reveal", { folder: at.folder }]] : [];
}
// Opens a folder in the file manager: Windows (Git Bash) Explorer, Linux xdg-open, macOS open.
const REVEAL = 'case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) explorer.exe "$(cygpath -w "$1" 2>/dev/null || printf %s "$1")" ;; *) if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"; else open "$1"; fi ;; esac';

function listItems(folder, machine = null) {
  folder = folder?.replace(/\/+$/, "");
  if (!folder || (!machine && folder === home())) return [];
  const { pinned, hidden, auto } = lists(machine);
  const at = machine ? { folder, machine } : { folder };
  // The list is what's pinned (over9k): Unpin takes it off and keeps it off.
  return pinned.includes(folder) ? [["Unpin from list", "list.unpin", at]] : [["Pin to list", "list.pin", at]];
}

// Grouping and separating picked terminals. Herdr can't move a pane between
// tabs, but a terminal can leave its pane and stay running (terminal.park) and
// then get a pane beside another one (terminal.keep), the same process and
// scrollback. A tab whose only pane leaves closes. Each step waits for Herdr to
// apply the last; a script, so it finishes after this menu closes.
const WAIT = `wait_for() { i=0; while [ $i -lt 40 ]; do
    if herdr-app ls | grep -q "\\"terminal\\": \\"$1\\""; then [ "$2" = in ] && return; else [ "$2" = out ] && return; fi
    i=$((i + 1)); sleep 0.1; done; }
move() { herdr-app do terminal.park "{\\"terminal\\":\\"$1\\"}" >/dev/null; wait_for "$1" out
  herdr-app do pane.focus "{\\"terminal\\":\\"$2\\"}" >/dev/null
  tab=$(herdr-app do terminal.keep "{\\"terminal\\":\\"$1\\"$3}" | sed -n 's/.*"tab": *"\\([^"]*\\)".*/\\1/p'); wait_for "$1" in; }`;
// $1 the terminal the rest join (the first is to its right, the others under that).
const GROUP = `${WAIT}
prev=$1; place=right; shift
for t in "$@"; do move "$t" "$prev" ",\\"place\\":\\"$place\\""; prev=$t; place=down; done`;
// Pairs: a terminal, then one that stays in its space (focused, so the new tab lands there).
const SEPARATE = `${WAIT}
# Herdr names a terminal's new tab after its address ("t3d"): back to its number.
while [ $# -ge 2 ]; do move "$1" "$2" ""; [ -n "$tab" ] && herdr-app do tab.rename "{\\"id\\":\\"$tab\\",\\"name\\":\\"\\"}" >/dev/null; shift 2; done`;

function movePanes(script, args) {
  exec("sh", ["-c", script, "sh", ...args]);
}

// What the picked panes allow: grouping 2+ terminals of one machine into the
// first one's tab (unless they're all there already), and separating those that
// share a tab with another pane into tabs of their own.
function paneMoves(picked) {
  const ps = panes().filter((p) => p.terminal), sp = spaces();
  const spaceOf = (p) => sp.find((s) => (s.tabs ?? []).some((t) => t.id === p.tab));
  const mine = picked.map((id) => ps.find((p) => p.pane === id)).filter(Boolean);
  const first = mine[0], machine = first && spaceOf(first)?.machine;
  const joining = mine.slice(1).filter((p) => p.tab !== first.tab && spaceOf(p)?.machine === machine);
  const group = first && joining.length ? [first.terminal, ...joining.map((p) => p.terminal)] : null;
  const pairs = mine.flatMap((p) => {
    const stays = ps.find((q) => q.tab === p.tab && q.pane !== p.pane && !picked.includes(q.pane))
      ?? ps.find((q) => q.tab === p.tab && q.pane !== p.pane && q.pane !== mine.find((m) => m.tab === p.tab)?.pane);
    return ps.filter((q) => q.tab === p.tab).length > 1 && stays ? [p.terminal, stays.terminal] : [];
  });
  return { group, separate: pairs.length ? pairs : null };
}

// Off the list: a pinned folder is unpinned, one listed by itself is hidden.
function unpin(folder) {
  const pinned = shared("projects.pinned") ?? [];
  listChange(pinned.includes(folder) ? "list.unpin" : "list.hide", folder);
}

function listChange(command, folder, machine = null) {
  const l = lists(machine);
  const pinned = new Set(l.pinned), hidden = new Set(l.hidden);
  // Unpinned by hand: the + menu's scan still offers it.
  const unpinned = new Set(l.unpinned);
  if (command === "list.pin") { pinned.add(folder); hidden.delete(folder); unpinned.delete(folder); }
  if (command === "list.unpin") { pinned.delete(folder); unpinned.add(folder); }
  if (command === "list.hide") hidden.add(folder);
  if (machine) {
    const all = shared("projects.on") ?? {};
    setShared("projects.on", { ...all, [machine]: { ...(all[machine] ?? {}), pinned: [...pinned], hidden: [...hidden], unpinned: [...unpinned] } });
    return;
  }
  setShared("projects.unpinned", [...unpinned]);
  setShared("projects.pinned", [...pinned]);
  setShared("projects.hidden", [...hidden]);
}

// Every close is reviewed in over9k-close so the complete affected set is
// revalidated before any terminal, pane, tab, or space command runs.
export function closeAsk(picked) {
  const p = plan(picked);
  if (!p.requiresConfirmation) return;
    openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 620, height: 520, props: { view: "close", ...picked } });
}

function menuIcon(command) {
  if (command === "pane.handoff") return "mods/sidebar-overhaul/handoff.svg";
  if (command.startsWith("visibility.")) return "mods/workspace-chrome/pin-off.svg";
  const name = command === "folder.reveal" ? "folder" : command === "panes.group" ? "layers" : command === "panes.separate" ? "panel-right" : command === "project.rename" ? "square-pen" : command === "project.open" ? "plus" : command === "icon.paste" ? "square" : command === "icon.choose" ? "folder" : command === "icon.find" ? "search" : command === "icon.remove" ? "x" : command === "list.pin" ? "pin" : command.startsWith("list.") ? "pin-off" : command.endsWith(".close") || command === "close-ask" || command === "close-many" ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(menuProps, cx) {
    this.menuProps = menuProps ?? {};
    this.git = null;
    this.discovered = [];
    this.discoveryError = "";
    this.reopen = [];
    this.filter = InputState.new({ placeholder: "Filter spaces or type a workspace path…" });
    this.filter.on("change", (_event, cx) => { this.at = 0; this.error = ""; cx.notify(); });
    this.filter.on("submit", (_event, cx) => this.submitMove(cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = this.menuProps;
    if (p?.tab === "move") {
      this.movingTerminal = p.target?.terminal;
      this.filter.focus();
      try { cx.spawn((cx) => this.loadWorktrees(cx)); } catch {}
    }
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  update(menuProps) {
    this.menuProps = menuProps ?? {};
  }

  filteredTargets(targets) {
    const query = this.filter?.value().trim().toLowerCase() ?? "";
    if (!query) return targets;
    return targets.filter((target) => [target.name, target.folder, target.machine, ...(target.sources ?? [])]
      .filter(Boolean).join(" ").toLowerCase().includes(query));
  }

  manualTarget() {
    const value = tildePath(this.filter?.value(), this.moveMachine ?? null);
    if (!value || !pathUnder(workspaceRoot(this.moveMachine ?? null), value, home())) return null;
    const folder = normalizeFolder(value);
    return { id: `manual:${this.moveMachine ?? "local"}:${folder}`, folder, machine: this.moveMachine ?? null, name: folder.split("/").filter(Boolean).pop() || folder, discovered: true, manual: true };
  }

  async submitMove(cx) {
    const targets = this.currentTargets ?? [];
    const selected = this.filteredTargets(targets)[this.at];
    if (selected) return this.moveTo(selected.id, cx);
    const manual = this.manualTarget();
    if (manual) return this.moveToTarget(manual, cx);
    this.error = "Choose a listed space or enter an absolute path under the workspace root.";
    cx.notify();
  }
  browseManual(cx) {
    if (this.moveMachine) {
      this.error = "Type a remote path under its workspace root; Browse is local-only.";
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Choose a workspace folder" });
      if (!folder) return;
      this.filter.set_value(folder.replace(/\\/g, "/").replace(/\/+$/, ""));
      this.error = "";
      this.at = 0;
      cx.notify();
    });
  }

  async moveToTarget(target, cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    cx.spawn(async (cx) => {
      try {
        const machine = target.machine ?? null;
        const machineHomePath = await machineHome(machine);
        const folder = expandPath(target.folder, machineHomePath);
        const existing = spaces().find((space) => (space.machine ?? null) === machine && normalizeFolder(expandPath(space.folder, machineHomePath)) === normalizeFolder(folder));
        if (!existing) {
          const check = await exec("test", ["-d", folder], machine ? { on: machine } : {}).catch(() => null);
          if (check?.code !== 0) {
            const root = workspaceRoot(machine);
            if (!pathUnder(root, folder, machineHomePath)) throw new Error(`Manual destination must stay under ${root}.`);
            const made = await exec("mkdir", ["-p", folder], machine ? { on: machine } : {}).catch(() => null);
            if (made?.code !== 0) throw new Error(made?.stderr || "Could not create the manual destination folder.");
          }
          run("space.new", { machine: machine ?? "", folder, name: target.name });
          for (let i = 0; i < 100; i++) {
            const created = spaces().find((space) => (space.machine ?? null) === machine && normalizeFolder(expandPath(space.folder, machineHomePath)) === normalizeFolder(folder));
            if (created) { target = created; break; }
            await cx.sleep(100);
          }
        } else target = existing;
        if (!target.id) throw new Error("The destination space has not appeared yet.");
        const snapshot = () => ({ spaces: spaces(), panes: panes(), agents: agents(), terminals: terminals() });
        await moveAgent(this.movingTerminal, target.id, { snapshot, exec, sleep: ms => cx.sleep(ms) });
        closeOverlay(this.menuProps?.overlay);
      } catch (error) { this.error = error.message; }
      this.busy = false;
      cx.notify();
    });
    cx.notify();
  }
  async loadWorktrees(cx) {
    const connected = (machines() ?? []).filter((machine) => machine?.name && machine.state === "connected");
    const found = [];
    for (const machine of connected) {
      const name = machine.name;
      const root = workspaceRoot(name);
      try { found.push(...await discoverWorktrees(name, { exec, root })); } catch {}
    }
    const recent = await recentMoveTargets();
    this.discovered = [...found, ...recent];
    cx.notify();
  }


  choose(i, cx) {
    const it = items(this.menuProps, this.git)[i];
    if (!it) return;
    if (it[1] === "agent.move") {
      closeOverlay(this.menuProps?.overlay);
      openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 0.82, height: 0.8, props: { tab: "move", target: it[2], view: "menu" } });
      return;
    }
    closeOverlay(this.menuProps?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "sidebar-overhaul", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: { view: "worktree", ...it[2] } });
    else if (it[1] === "workspace.settings") openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 780, height: 640, props: { view: "options", ...it[2] } });
    else if (it[1] === "machine.settings") openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 780, height: 640, props: { view: "options", page: "machines", computer: it[2].machine } });
    else if (it[1] === "close-ask") closeAsk(it[2]);
    else if (it[1] === "project.open") openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 340, height: 640, props: { view: "new-menu", ...it[2] } });
    else if (it[1] === "folder.reveal") exec("sh", ["-c", REVEAL, "sh", it[2].folder]).catch(() => null);
    else if (it[1] === "project.rename") openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 380, height: 200, props: { view: "rename", folder: it[2].folder, machine: it[2].machine, value: it[2].name, title: "Rename space" } });
    else if (it[1] === "pane.rename") renamePane(it[2]);
    else if (it[1] === "visibility.hide") queueVisibility("hide", it[2]);
    else if (it[1] === "visibility.hide-group") queueVisibility("hide-group", it[2]);
    else if (it[1] === "folder.copy") cx.write_to_clipboard(it[2].folder);
    else if (it[1] === "agent.copy-id") cx.write_to_clipboard(it[2].id);
    else if (it[1] === "pane.handoff") {
      const a = agents().find((x) => x.address === it[2].terminal);
      const p = panes().find((x) => x.terminal === it[2].terminal);
    openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 420, height: 360, props: { view: "handoff", terminal: it[2].terminal, name: (a && agentTask(a, p?.cwd)) || a?.program?.name } });
    }
    else if (it[1] === "panes.group") movePanes(GROUP, it[2]);
    else if (it[1] === "panes.separate") movePanes(SEPARATE, it[2]);
    else if (it[1] === "close-many") {
      const rest = { spaces: it[2].spaces, panes: it[2].panes, subs: it[2].subs ?? it[2].subRows };
    if (plan(rest).requiresConfirmation) openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 620, height: 520, props: { view: "close", ...rest } });
    }
    else if (it[1] === "list.unpin-many") for (const f of it[2].folders) unpin(f);
    else if (it[1].startsWith("list.")) listChange(it[1], it[2].folder, it[2].machine ?? null);
    else run(it[1], it[2]);
  }

  moveTo(id, cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    cx.spawn(async (cx) => {
      try {
        const snapshot = () => ({ spaces: spaces(), panes: panes(), agents: agents(), terminals: terminals() });
        const state = snapshot();
        const targets = moveTargets(this.movingTerminal, { ...state, discovered: this.discovered });
        let target = targets.find((item) => item.id === id);
        if (!target) throw new Error("Choose an available destination space.");
        if (target.discovered) {
          const same = () => spaces().find((space) => (space.machine ?? null) === (target.machine ?? null) && normalizeFolder(space.folder) === normalizeFolder(target.folder));
          const existing = same();
          if (existing) target = existing;
          else {
            run("space.new", { machine: target.machine ?? "", folder: target.folder, ...(target.name ? { name: target.name } : {}) });
            for (let i = 0; i < 100; i++) {
              target = same();
              if (target) break;
              await cx.sleep(100);
            }
            if (!target) throw new Error("The new destination space has not appeared yet.");
          }
        }
        await moveAgent(this.movingTerminal, target.id, { snapshot, exec, sleep: ms => cx.sleep(ms) });
        closeOverlay(this.menuProps?.overlay);
      } catch (error) { this.error = error.message; }
      this.busy = false;
      cx.notify();
    });
    cx.notify();
  }
  movePicker() {
    const t = theme();
    const targets = moveTargets(this.movingTerminal, { spaces: spaces(), panes: panes(), agents: agents(), terminals: terminals(), discovered: this.discovered });
    const machineNames = [...new Set([...targets.map(s => s.machine ?? null), ...(machines() ?? []).map(m => m.name).filter(Boolean)])];
    const machineTabs = machineNames;
    this.moveMachine ??= machineTabs[0] ?? null;
    if (!machineTabs.includes(this.moveMachine)) this.moveMachine = machineTabs[0] ?? null;
    const visible = this.filteredTargets(targets.filter(s => (s.machine ?? null) === this.moveMachine));
    return v_flex().id("move-agent").track_focus(this.handle).size_full().min_h(0).p(16).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && !this.busy) closeOverlay(this.menuProps?.overlay);
        else if (e.key === "enter") this.submitMove(cx);
        else if (e.key === "down" && visible.length) this.at = (this.at + 1) % visible.length;
        else if (e.key === "up" && visible.length) this.at = (this.at + visible.length - 1) % visible.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(16).font_semibold().text_color(t.foreground).child("Move agent to space"))
        .child(div().text_size(11).text_color(t.dim).child("Enter select / create  ·  Esc close")))
      .child(h_flex().h(38).flex_none().gap(8).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.filter).flex_1().h_full().px(10).text_color(t.foreground))
        .child(div().id("move-browse").h(28).px(9).flex_none().items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.foreground)
          .bg(t.raised).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.browseManual(cx)).child("Browse…")))
      .child(h_flex().items_center().gap(8).text_size(11).text_color(t.dim)
        .child(div().flex_1().child(`Workspace root: ${workspaceRoot(this.moveMachine ?? null)}`))
        .child(div().flex_none().child(`${visible.length} destination${visible.length === 1 ? "" : "s"}`)))
      .child(h_flex().id("move-machines").flex_none().gap(4).children(machineTabs.map(machine => h_flex().id(`move-machine-${machine ?? "local"}`).h(30).px(10).items_center().rounded(6).cursor_pointer()
        .bg((machine ?? null) === this.moveMachine ? t.selected : t.raised).text_color((machine ?? null) === this.moveMachine ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.moveMachine = machine ?? null; this.at = 0; cx.notify(); }).child(machine ?? "This computer"))))
      .when(Boolean(this.error), el => el.child(div().px(8).py(5).rounded(6).bg(t.ansi1 + "20").text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("move-targets").flex_1().min_h(0).overflow_y_scrollbar().rounded(8).border_1().border_color(t.border).p(4)
        .when(!visible.length, el => el.child(div().p(12).text_color(t.muted).child(this.manualTarget() ? `Press Enter to create and move to ${this.manualTarget().folder}` : "No matching spaces. Type a path under the workspace root or choose Browse…")))
        .children(visible.map((s, index) => v_flex().id(`move-to-${s.id}`).flex_none().px(12).py(9).rounded(7)
          .when(index === this.at, el => el.bg(t.selected)).hover(el => el.bg(t.hover)).on_click((_e, cx) => this.moveTo(s.id, cx))
          .child(div().truncate().text_color(t.foreground).child(s.name || s.folder))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child([s.folder, s.machine ?? "This computer"].join("  ·  ")))
          .when(Boolean(s.sources), el => el.child(div().truncate().text_size(10.5).text_color(t.accent).child(s.sources.join(" / "))))
          .when(Boolean(s.discovered), el => el.child(div().truncate().text_size(10.5).text_color(t.accent).child("Creates a space here"))))));
  }

  render(cx) {
    if (this.movingTerminal) return this.movePicker();
    const t = theme();
    const list = items(this.menuProps, this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(this.menuProps?.overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "close-ask" || (it[1].startsWith("list.") && !list[i - 1][1].startsWith("list.")) || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
