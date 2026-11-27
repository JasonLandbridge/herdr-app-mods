// Over9k: the sidebar's spaces, terminals and agents in one list (help and
// options: over9k-options). Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by computer (This computer always has its heading). After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.
// Projects are git repos in the projects folder (Options › Folders) and folders with a CLAUDE.md,
// AGENTS.md or .claude folder, plus ones pinned from the right-click menu, less hidden ones; with no open space they stay listed in a folded "Not open" section.
// Every terminal and agent lists under the project or space its live folder is
// in (any other folder gets a row of its own; ~ itself is the home space) in
// Space view. Status view groups those agent rows by state. Rows show the
// GitHub link, uncommitted files, unpushed/unpulled commits and open PRs, each
// one clickable.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, terminals, setAgentOrder, run, openOverlay, exec, hc, home, appHome, readTextFile, theme, shared, setShared, watchFolder, window, layout, notify, focused } from "herdr";
import { codexTitle, agentTask, isCodex, sentenceCase } from "./agent-name.js";
import { getSidebarConfig, updateSidebarConfig, currentSidebarConfig } from "../../config-store.js";
import { lookupLocation, lookupMachineOption } from "../../config.js";
import { WORKTREE_LABELS, normalizeRoot } from "../over9k-worktree/worktree-hooks.js";
async function sidebarConfig() {
  return currentSidebarConfig() ?? (await getSidebarConfig({
    home: home(), machines: machines(), options: { ...shared("sidebar.options") },
    locations: shared("over9k.locations"), remoteLocations: shared("over9k.remoteLocations"),
    projects: { local: { pinned: shared("projects.pinned"), hidden: shared("projects.hidden"), unpinned: shared("projects.unpinned"), listed: shared("projects.listed") }, remote: shared("projects.on") },
    names: shared("projects.names"),
  })).config;
}
import { plan, plural, visualSnapshotIdentity } from "./close-plan.js";

const machineLocation = (config, machine, key, fallback) => {
  const legacy = machine === null
    ? config?.options?.locations ?? shared("sidebar.options")?.locations ?? {}
    : config?.options?.computers?.[machine] ?? shared("sidebar.options")?.computers?.[machine] ?? {};
  const oldShared = machine === null ? shared("over9k.locations")?.[key] : shared("over9k.remoteLocations")?.[machine]?.[key];
  return lookupLocation(config, machine, key, legacy[key] ?? oldShared ?? fallback);
};

const localScanSettings = (config) => ({
  chats: machineLocation(config, null, "chats", "~"),
  projects: machineLocation(config, null, "projects", "~"),
  keepUpToDate: lookupMachineOption(config, null, "keepUpToDate", shared("sidebar.options")?.keepUpToDate),
});
import { orderBlocks } from "./ordering.js";
import {
  actionQueue,
  applyVisibilityAction,
  emptyVisibilityState,
  isExplicitlyHidden,
  isRevealed,
  normalizeVisibilityState,
  pruneEnded,
  startVisibilitySession,
  VISIBILITY_ACTIONS,
  VISIBILITY_STATE,
  withEffective,
} from "./agent-visibility.js";
import {
  applyPresentationAction,
  observePresentation,
  startPresentationSession,
} from "./agent-presentation.js";
import { isAgentTerminal, reportedTerminalStatus, terminalStatus } from "./agent-classifier.js";
import { folderGroupKey, groupHasPassingPane, visualGroupForPane } from "./grouping.js";
import {
  RECOVERY_STATE,
  captureRecoveryRecords,
  findVerifiedRecoveryRecord,
  mergeRecoveryState,
  normalizeRecoveryState,
} from "./recovery-state.js";
import {
  WORKING_SETS_STATE,
  applyWorkingSetVisibility,
  normalizeWorkingSetsState,
  selectWorkingSet,
  visibleGroupSelectors,
} from "./working-sets.js";
import {
  HIDDEN_LISTINGS,
  HIDDEN_REMOVALS,
  applyHiddenRemovals,
  groupListingKey,
  isGroupDismissed,
  normalizeHiddenListings,
} from "./hidden-listings.js";
import { createRenderDiagnostics } from "./render-diagnostics.js";

// Python 3 runs as "python3", else "python" (as on Windows): found once.
let PY = null;
const python = (args) => (PY ??= exec("python3", ["-c", "1"]).then((r) => (r?.code === 0 ? "python3" : "python"), () => "python"))
  .then((p) => exec(p, args));
function agentLike(term) {
  return isAgentTerminal(term);
}
function reportedAgentStatus(value) {
  const status = reportedTerminalStatus(value);
  return status === "needs-input" ? "blocked" : status;
}
function terminalAgentStatus(term) {
  const status = terminalStatus(term);
  return status === "needs-input" ? "blocked" : status;
}

// Every affected agent is listed before a destructive close, including idle,
// hidden and descendant agents.
function closeAsk(picked) {
  const p = plan(picked);
  if (p.requiresConfirmation) openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 620, height: 520, props: { ...picked, view: "close" } });
}

// Whether a mod shows anywhere in this layout.
function hasMod(node, mod) {
  return Boolean(node) && (node.content?.mod === mod || (node.children ?? []).some((c) => hasMod(c, mod)));
}
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
// Every call into Herdr waits for its main thread (a frame when terminals are
// busy), so a render reads each thing once: the home folder is kept here, and
// render keeps spaces, panes, agents and shared colors in this.frame.

// A worktree row's branch icon lines up with the terminal icons; its own
// terminals go in by the icon and gap, under its name.
const TREE = 22;

let HOME = null;
const homeDir = () => (HOME ??= home());
// A path as it's shown on hover: home as ~.
const tilde = (path) => { const p = (path ?? "").replace(/\/+$/, ""); return p === homeDir() ? "~" : p.startsWith(homeDir() + "/") ? `~${p.slice(homeDir().length)}` : p; };
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is: the folder it was made for, not where its terminals went
// (they list under the project they're in now, see `assign`), so its row keeps
// its project's git. `ps` is unused, kept so callers match the shipped mod.
function place(s, _ps) {
  return s.folder;
}
// A space's name in the list: its own when someone named it, else its folder's
// (Herdr would call it after wherever its first terminal went).
const title = (s) => (s.named || s.machine ? s.name : !s.folder || s.folder.replace(/\/+$/, "") === homeDir() ? "~" : base(s.folder));
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// How often each GitHub repo is fetched (so ↓ is current) and its pull requests
// counted. Git never asks for a password here: it fails instead.
const REMOTE = 300000;
const QUIET = ["GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes"];
// Folders in a code folder that are never offered as projects (by name; unpin
// or hide one from its right-click menu instead), and how often new ones are looked for.
const SKIP = new Set();
const RESCAN = 30000;
// Project folders: a git repo in a code folder (the arguments), or anywhere up
// to two levels under home a folder set up for an agent (CLAUDE.md,
// CLAUDE.local.md, AGENTS.md, a .claude folder). Git alone elsewhere is usually
// installed software. Hidden folders under home and node_modules aren't looked in.
const MARKED = `{ for d in "$@"; do case "$d" in "~") d=$HOME ;; "~/"*) d="$HOME/\${d#"~/"}" ;; esac
    find "$d" -mindepth 2 -maxdepth 2 -name .git 2>/dev/null; done
  find "$HOME" -maxdepth 3 \\( -path "$HOME/.*" -o -name node_modules \\) -prune -o \\
    \\( -name CLAUDE.md -o -name CLAUDE.local.md -o -name AGENTS.md -o \\( -name .claude -type d \\) \\) -print 2>/dev/null
} | sed 's#/[^/]*$##' | sort -u`;
// A computer's two places (set in over9k-options): Chats, where conversations
// about no project start (home unless set), and Projects, where every git repo
// is a project and hand-offs (handoff.sh) make new ones. Unset, Projects is the
// folder that computer's CLAUDE.md/AGENTS.md name on a line about projects (a
// `~/…` in backticks; over9k's own rule left out), else home. Prints it as typed.
const PROJECTS_FROM_RULES = `for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"; do
  [ -f "$f" ] && sed '/<!-- over9k:handoff -->/,/<!-- \\/over9k:handoff -->/d' "$f"
done | grep -i 'project' | grep -oE '\`~/[^\` ]+\`' | tr -d '\`' | sed 's#/*$##' | while read -r d; do
  [ -d "$HOME/\${d#"~/"}" ] && { printf '%s' "$d"; break; }
done`;

// Widths of the right-hand columns: new tab, fold chevron (px).
const FOLD = 16;
const ADD = 22;
// Shift, Cmd/Meta or Ctrl + click picks rows; right-click a picked one to close or unpin them.
const multi = (e) => Boolean(e?.modifiers && (e.modifiers.shift || e.modifiers.platform || e.modifiers.control));
const inside = (cwd, dir) => cwd === dir || cwd?.startsWith(dir + "/");

const isPi = (a) => a.app === "pi" || a.program?.key === "pi";
// Possibly Antigravity: agy-info.py, which only answers for terminals agy runs in,
// is asked about any agent that isn't Claude Code, Codex or Pi.
const isAgy = (a) => !isClaude(a) && !isPi(a) && !/codex/i.test(`${a.app ?? ""} ${a.program?.key ?? ""}`);
const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";
// Pi's footer: "↑5.5k ↓72 8.6%/66k (auto)  …  qwen3.8-27b • medium" (tokens in and
// out once it has replied, then context used, model, thinking).
function piFooter(text) {
  for (const line of (text ?? "").split("\n").reverse()) {
    const m = /(?:^|\s)(\d+(?:\.\d+)?)%\/\S+.*?\s(\S+)(?: \u2022 (\S+))?\s*$/.exec(line);
    if (m) return { context: Number(m[1]), model: m[2], effort: m[3] ?? null };
  }
  return null;
}

// Running remote connections (ssh, mosh, tailscale ssh, et) with the Herdr
// terminal they were started in: one line each, terminal, the folder it runs
// in, then the command's words, tab-separated (Linux's /proc).
const SSH_PROCS = `for p in $(pgrep -x 'ssh|mosh|mosh-client|tailscale|et'); do
  t=$(tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^HC_TERMINAL_ID=//p')
  [ -n "$t" ] && printf '%s\\t%s\\t%s\\n' "$t" "$(readlink /proc/$p/cwd)" "$(tr '\\0' '\\t' < /proc/$p/cmdline)"
done`;
// The destination in a connection's words, and how: the first word that isn't
// an option (or an option's value); tailscale only counts as "tailscale ssh".
function sshDestination(args) {
  const prog = (args[0] ?? "").split("/").pop();
  const how = prog === "tailscale" ? (args[1] === "ssh" ? "tailscale" : null) : prog.startsWith("mosh") ? "mosh" : prog;
  if (!how) return null;
  const takes = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));
  for (let i = how === "tailscale" ? 2 : 1; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a.startsWith("-")) {
      if (how === "ssh") {
        if (a === "-o" || a.startsWith("-o")) {
          const option = a === "-o" ? args[++i] : a.slice(2);
          if (/^SessionType[=\s]+none$/i.test(option ?? "")) return null;
          continue;
        }
        for (const flag of a.slice(1)) {
          if (flag === "N" || flag === "O") return null;
          if (takes.has(flag)) {
            if (a === `-${flag}`) i++;
            break;
          }
        }
      }
      continue;
    }
    return { dest: a, how };
  }
  return null;
}

// 42000 tokens is "42k"; 1500000 is "1.5M".
function tokensK(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
// A duration in seconds as "40s", "3m", "1h 5m".
function span(sec) {
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : sec < 86400 ? `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`
    : `${Math.floor(sec / 86400)}d ${Math.round((sec % 86400) / 3600)}h`;
}
// Times written out in words ("every 2 hours at :13") in short units: s, m, h, d,
// w, mo, y ("every 2h at :13"); "every hour" is "every 1h".
const UNITS = [["seconds?|secs?", "s"], ["minutes?|mins?", "m"], ["hours?|hrs?", "h"], ["days?", "d"], ["weeks?", "w"], ["months?", "mo"], ["years?", "y"]];
function short(text) {
  return UNITS.reduce((out, [words, u]) => out
    .replace(new RegExp(`(\\d+)\\s*(?:${words})\\b`, "gi"), `$1${u}`)
    .replace(new RegExp(`\\bevery\\s+(?:${words})\\b`, "gi"), (m) => `${m.split(/\s+/)[0]} 1${u}`), text);
}

// A terminal's program is an agent (Herdr names any program there, "sleep" too).
function isAgentProgram(name) {
  return /^(claude|codex|pi|opencode|gemini|aider|amp|cursor|omp)/i.test(name ?? "");
}

// A program's icon (an agent's: Claude, Codex, Pi), else a shell's.
function progIcon(prog, t, size) {
  return prog?.icon ? (prog.tint ? svg(prog.icon).size(size).flex_none().text_color(t.foreground) : image(prog.icon).w(size).h(size).flex_none())
    : svg("icons/shell.svg").size(size).flex_none().text_color(t.foreground);
}

// An effort as rows show it: "medium" is "med".
const effortName = (e) => (e === "medium" ? "med" : e || null);
// A Claude model id as people say it: "claude-haiku-5-5" is "Haiku 5.5".
function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id ?? "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id ?? "";
}


// Each link (something working in another space, or on another computer over
// ssh) gets a colour of its own, the same at both ends (linkColor, linkChip):
// the avatars' (MARK) first, blue leading, then six more at the same strength.
const LINK_COLORS = ["#5b8def", "#e3814f", "#3fae6a", "#d9649a", "#8b7cf6", "#22a99a",
  "#d4a72c", "#e05a5a", "#3ba7d9", "#8cb83a", "#c26bd6", "#b08a5a"];
// `icon`: BOT for an agent run in a terminal of its own (Herdr's: Codex, Pi,
// Claude), SUB (a smaller, round robot) for a Claude Code subagent, CPU for a
// process (a server, a build).
const BOT = "mods/sidebar-overhaul/bot.svg", SUB = "mods/sidebar-overhaul/subagent.svg", CPU = "mods/sidebar-overhaul/cpu.svg";
// A Claude Code session's scheduled prompt (CronCreate, /loop).
const CLOCK = "mods/sidebar-overhaul/clock.svg";
// A chip linking what an agent started with the space it works in: "out" on its
// row under the agent (its icon, then an arrow), "in" on its row in that space
// (an arrow, then its icon). Hovering either row lights up the other
// (view.hoverLink, set by the row: lit). `to` (an ssh's computer): the server
// icon its heading has after the arrow; hovering lights its row under there.
function linkChip(t, id, { dir, icon, color, to = null }) {
  return h_flex().id(id).flex_none().h(16).px(4).gap(3).items_center().rounded(4).bg(color + "26").text_size(10.5).text_color(color)
    .when(dir === "in", (el) => el.child(div().flex_none().child("\u2192")))
    .child(svg(icon).size(icon === SUB ? 13 : 10).flex_none()) // the round subagent robot is drawn smaller
    .when(dir === "out", (el) => el.child(div().flex_none().child("\u2192")))
    .when(Boolean(to), (el) => el.child(svg("mods/workspace-chrome/server.svg").size(10).flex_none()));
}

// A row lit up while its other end is hovered (a row with a link chip there).
const lit = (el, link) => (link ? el.bg(link.color + "26") : el);

// The list has one of two views: Space is the complete list, while Status is
// the agent priority grouping. The selection belongs to the sidebar itself.
const SECTIONS = [
  { status: "blocked", label: "Needs you" },
  { status: "done", label: "Done" },
  { status: "working", label: "Working" },
  { status: "idle", label: "Idle" },
  { status: "inactive", label: "Inactive" },
];

// The panel stack's block for a sub-row clicked open (showInPanel).
const PANEL_VIEW = "sub-view";

// Details in a row, close: "Opus 5.5·high·35%" (a dot between each, a pixel of room around it).
const dotted = (parts) => parts.flatMap((el, n) => (n ? [div().px(1).child("\u00b7"), el] : [el]));

// Agent rows' layout and what they show, until over9k-options says otherwise
// (shared "sidebar.options"; the same defaults as there).
const OPTIONS = { keepUpToDate: false, layout: "expanded", model: true, effort: true, context: true, since: true, cache: true, github: true, dirty: true, sync: true, prs: true, stars: true, issues: true,
  subModel: true, subEffort: true, subContext: true, subTime: true };

// Model families with a logo of their own, a badge on the agent's icon.
const FAMILY = [{ match: /qwen/i, icon: "mods/sidebar-overhaul/qwen.svg", color: "#6f69f7" }];
// An agent's name: its tab's name when someone named it, else its session's
// title (agent-name.js), else the program. Tab numbers and addresses aren't names.
// Herdr knows some agents only by app (Antigravity: no program): named after it.
const APP_NAMES = { antigravity: "Antigravity" };
const appName = (a) => a?.program?.name || APP_NAMES[a?.app] || null;
function agentName(a, tab, cwd) {
  if (tab && tab.name !== a.program?.name && !/^(\d+|t[0-9a-z]+)$/.test(tab.name)) return tab.name;
  return agentTask(a, cwd) || appName(a) || a.address;
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
// Each project's color, from its folder's name, so it's the same open or not
// (and in the picker, which reads space.colors). Home has none.
const project = (s) => (s.folder === homeDir() ? null : base(s.folder));
function hue(name) {
  if (!name) return null;
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  const keys = Object.keys(MARK);
  return keys[h % keys.length];
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    // The sidebar instance owns transient presentation history. Visibility
    // selections remain persisted under the established shared key, while the
    // drawer itself starts collapsed for each sidebar/reload lifetime.
    this.visibility = startVisibilitySession(shared(VISIBILITY_STATE) ?? emptyVisibilityState());
    this.recovery = normalizeRecoveryState(shared(RECOVERY_STATE));
    this.workingSets = normalizeWorkingSetsState(shared(WORKING_SETS_STATE));
    const reload = shared("over9k.reload");
    this.reloadRequestId = reload?.status === "pending" ? reload.requestId : null;
    this.presentation = startPresentationSession();
    setShared(VISIBILITY_STATE, this.visibility);
    setShared(VISIBILITY_ACTIONS, []);
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    this.recent = shared("over9k.recentAgents") ?? [];
    cx.timer.every(500, () => this.trackRecent());
    this.projects = []; // shown projects: Claude's folders + pinned - hidden (see render)
    this.auto = []; // ~/Code git repos and folders with a CLAUDE.md, AGENTS.md or .claude
    this.tops = new Map(); // a terminal's folder -> its repo's top (else itself)
    // A shell's last command: the last prompt line ("❯ make") on its screen,
    // kept once seen (a clear wipes the screen). Shared as terminals.last for
    // the tab bar (over9k-tabs).
    this.lastCmd = {};
    cx.timer.every(4000, (cx) => this.readCommands(cx));
    // Spaces whose agents are folded away, and whether the not-open projects show.
    this.agentsFolded = new Set(JSON.parse(localStorage.getItem("agents.folded") ?? "[]"));
    this.closedOpen = localStorage.getItem("projects.closedOpen") === "true";
    this.scanProjects(cx);
    cx.spawn(async (cx) => {
      try { await sidebarConfig(); this.config = currentSidebarConfig(); cx.notify(); } catch {}
    });
    // Other computers' Projects and Chats (over9k-options, per computer) and
    // the projects found there, by machine name; looked for over SSH, less often.
    try { this.remote = JSON.parse(localStorage.getItem("remote.projects") ?? "{}"); } catch { this.remote = {}; }
    // What was found on each, for the menus' Pin/Unpin (over9k-menu, over9k-new-menu).
    const autoOn = Object.fromEntries(Object.entries(this.remote).map(([m, f]) => [m, f.dirs ?? []]));
    if (JSON.stringify(autoOn) !== JSON.stringify(shared("projects.autoOn") ?? {})) setShared("projects.autoOn", autoOn);
    this.closedOpenOn = JSON.parse(localStorage.getItem("projects.closedOpenOn") ?? "{}");
    // Model, effort and context per agent, one file per Herdr terminal here:
    // claude-info.py writes Claude Code's (from its own session and conversation
    // files; no status line), Antigravity's status line its own (optional).
    this.info = {};
    this.infoDir = `${homeDir()}/.cache/over9k/agents`;
    // Pi's info, from its footer on screen; models other than an agent's own
    // (Pi's model list: name and server), and the effort each local server runs at.
    this.piInfo = {};
    this.models = {};
    this.serverEffort = {};
    this.serversUp = {}; // port -> pid of a local model server running
    this.hoverServer = null; // the server chip under the pointer: it reads "Stop …"
    // When each agent last stopped working (ms), seen here for any agent;
    // Claude Code's status line also says when it last replied (lastAt).
    try { this.lastWork = JSON.parse(localStorage.getItem("agents.lastWork") ?? "{}"); } catch { this.lastWork = {}; }
    this.wasWorking = {};
    // Agents whose sub-agents are shown (folded by default).
    try { this.subsOpen = new Set(JSON.parse(localStorage.getItem("agents.subsOpen") ?? "[]")); } catch { this.subsOpen = new Set(); }
    this.loadView();
    // A close of picked sub-rows already done before a reload isn't done again.
    this.closedAt = shared("over9k.closeSubs")?.at ?? null;
    cx.timer.every(60000, (cx) => cx.notify()); // the "3m"s move on
    this.loadInfo(cx);
    this.prs = {}; // "owner/repo" -> { open, review }: open pull requests, those asking you
    this.write = {}; // "owner/repo" -> you can push there (yours, or your team's)
    this.repoInfo = {}; // "owner/repo" -> { stars, issues }: its stars and open issues on GitHub
    this.me = null; // your GitHub login
    this.armed = null; // ↑ clicked once: { repo, until }; a second click pushes
    this.sel = new Set(); // Ctrl+clicked rows: "s:<space>", "p:<pane>", "d:<project folder>"
    cx.timer.after(5000, (cx) => this.refreshRemote(cx));
    cx.timer.every(REMOTE, (cx) => this.refreshRemote(cx));
    cx.timer.every(5000, (cx) => this.loadInfo(cx));
    // Looked for at start and when the folders change (loadInfo); again every
    // RESCAN only with over9k-options' "Keep sidebar up to date" on.
    cx.timer.every(RESCAN, cx => {
      const config = currentSidebarConfig();
      if (localScanSettings(config).keepUpToDate) this.scanProjects(cx);
      this.scanRemote(cx, this.machines.filter(m => m.name && m.state === "connected" && lookupMachineOption(config, m.name, "keepUpToDate", shared("sidebar.options")?.keepUpToDate)).map(m => m.name));
    });
    cx.timer.after(8000, cx => this.scanRemote(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }
  visibilityState() {
    return this.visibility ?? normalizeVisibilityState(shared(VISIBILITY_STATE) ?? emptyVisibilityState());
  }

  recoveryState() {
    return this.recovery ?? normalizeRecoveryState(shared(RECOVERY_STATE));
  }

  allGroupSelectors() {
    const values = new Map();
    for (const [key, group] of this.frame?.groupMeta ?? []) values.set(key, group);
    for (const [key, group] of Object.entries(this.visibilityState().groups ?? {})) if (!values.has(key)) values.set(key, group);
    return visibleGroupSelectors(values);
  }

  currentVisibleGroupSelectors() {
    return this.allGroupSelectors().filter((group) => !this.isHiddenGroup(group.nativeKey ?? group.key));
  }

  captureRecovery() {
    // Hover redraws only compare live metadata, never read or merge the archive.
    const records = captureRecoveryRecords(this.frame, null);
    const previous = this.recoverySignatures;
    const signatures = new Map();
    for (const record of records) {
      const signature = JSON.stringify(record);
      signatures.set(record.key, signature);
      if (previous?.get(record.key) !== signature) {
        (this.pendingRecovery ??= new Map()).set(record.key, { ...record, lastSeen: Date.now() });
      }
    }
    this.recoveryCapture = records;
    this.recoverySignatures = signatures;
  }

  persistRecovery() {
    if (!this.pendingRecovery?.size) return;
    const saved = shared(RECOVERY_STATE);
    const next = mergeRecoveryState(saved ?? this.recovery, [...this.pendingRecovery.values()]);
    if (JSON.stringify(next) !== JSON.stringify(saved)) setShared(RECOVERY_STATE, next);
    this.recovery = next;
    this.pendingRecovery.clear();
  }

  hiddenListingsState() {
    return this.hiddenListings ?? normalizeHiddenListings(shared(HIDDEN_LISTINGS));
  }

  applyPendingHiddenRemovals() {
    this.hiddenListings = normalizeHiddenListings(shared(HIDDEN_LISTINGS));
    const pending = shared(HIDDEN_REMOVALS);
    if (!Array.isArray(pending) || !pending.length) return;
    const next = applyHiddenRemovals({
      visibility: this.visibilityState(),
      listings: this.hiddenListings,
      pending,
      terminals: this.frame.terms,
      machines: this.frame.ms,
    });
    this.visibility = next.visibility;
    this.hiddenListings = next.listings;
    for (const [key, value] of [[VISIBILITY_STATE, next.visibility], [HIDDEN_LISTINGS, next.listings], [HIDDEN_REMOVALS, next.pending]]) {
      if (JSON.stringify(shared(key)) !== JSON.stringify(value)) setShared(key, value);
    }
  }

  publishVisualGroups(identity) {
    const terminals = new Map(this.frame.terms.map((term) => [term.address, term]));
    const paneAddresses = new Set(this.frame.ps.map((pane) => pane.terminal).filter(Boolean));
    const groups = new Map();
    const groupFor = (key, meta) => {
      if (!groups.has(key)) groups.set(key, {
        key,
        kind: meta.kind === "space" ? "space" : "project",
        label: meta.label ?? key,
        machine: meta.machine ?? null,
        folder: meta.folder ?? null,
        members: new Map(),
      });
      return groups.get(key);
    };
    const add = (group, address) => {
      const terminal = terminals.get(address);
      if (!terminal || terminal.state !== "live") return;
      group.members.set(address, {
        address,
        created_ms: typeof terminal.created_ms === "number" && Number.isFinite(terminal.created_ms) ? terminal.created_ms : null,
      });
    };
    for (const [key, meta] of this.frame.groupMeta) groupFor(key, meta);
    for (const [key, rows] of this.frame.groups) {
      const group = groupFor(key, this.frame.groupMeta.get(key) ?? {});
      for (const { p } of rows) if (p?.terminal) add(group, p.terminal);
    }
    for (const record of this.recoveryCapture ?? []) {
      if (!record.visual?.key || paneAddresses.has(record.address)) continue;
      add(groupFor(record.visual.key, record.visual), record.address);
    }
    const snapshot = {
      version: 1,
      identity,
      groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map((group) => ({
        ...group,
        members: [...group.members.values()].sort((a, b) => a.address.localeCompare(b.address)),
      })),
    };
    if (JSON.stringify(shared("over9k.visualGroups")) !== JSON.stringify(snapshot)) setShared("over9k.visualGroups", snapshot);
  }

  openHiddenMenu(hidden) {
    openOverlay({
      mod: "sidebar-overhaul",
      kind: "popup",
      width: 260,
      height: hidden.kind === "agent" ? 105 : 72,
      props: { tab: "hidden", hidden, view: "menu" },
    });
  }

  agentMenuButton(address, t, open = () => openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 220, height: 155,
    props: { tab: "agent", target: { terminal: address }, view: "menu" } })) {
    return h_flex().id(`agent-menu-${address}`).size(20).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.raised).text_color(t.foreground)).tooltip("Agent actions")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); open(); }).child("⋯");
  }

  openRecovery(recordKey = null, scope = null) {
    this.persistRecovery();
    openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 620, height: 560, props: { recordKey, ...(scope ?? {}), view: "recovery" } });
  }


  openWorkingSets() {
    openOverlay({
      mod: "sidebar-overhaul",
      kind: "dialog",
      width: 440,
      height: 520,
      props: { selectors: this.allGroupSelectors(), visibleSelectors: this.currentVisibleGroupSelectors(), view: "working-sets" },
    });
  }

  clearWorkingSet(cx) {
    this.workingSets = selectWorkingSet(shared(WORKING_SETS_STATE), null);
    setShared(WORKING_SETS_STATE, this.workingSets);
    cx?.notify();
  }

  acknowledgeReload() {
    if (!this.reloadRequestId) return;
    const current = shared("over9k.reload");
    if (current?.status !== "pending" || current.requestId !== this.reloadRequestId) return;
    setShared("over9k.reload", { ...current, status: "acknowledged", acknowledgedAt: Date.now() });
  }

  ownershipBadge(meta, t) {
    const owner = meta?.owner;
    const visual = meta?.visual;
    if (!owner?.id || !visual?.key || owner.id === visual.key
      || (owner.folder && visual.folder && owner.folder.replace(/\/+$/, "") === visual.folder.replace(/\/+$/, ""))) return null;
    const ownerLabel = owner.name || owner.folder || owner.id;
    const visualLabel = visual.label || visual.folder || visual.key;
    return div().id(`ownership-${owner.id}-${visual.key}`).px(3).rounded(3).text_size(9.5).text_color(t.accent)
      .bg(t.accent + "20").tooltip(`Visual group ${visualLabel}; actual native owner ${ownerLabel}`)
      .child(`Owner: ${ownerLabel}`);
  }
  restoreView(mode) {
    this.viewMode = mode === "status" ? "status" : "space";
    try { localStorage.setItem("sidebar.view", this.viewMode); } catch {}
    return this.viewMode;
  }

  loadView() {
    let saved = null;
    let filter = null;
    let by = null;
    try {
      saved = localStorage.getItem("sidebar.view");
      filter = localStorage.getItem("agents.filter");
      by = localStorage.getItem("agents.by");
    } catch {}
    if (saved === "space" || saved === "status") this.viewMode = saved;
    else this.restoreView(filter === "agents" && by !== "space" ? "status" : "space");
    if (filter !== null || by !== null) {
      try {
        localStorage.removeItem("agents.filter");
        localStorage.removeItem("agents.by");
      } catch {}
    }
    return this.viewMode;
  }

  statusView() {
    return this.viewMode === "status";
  }

  // Presentation is reduced from this sidebar's current raw frame. A normal
  // row click updates it synchronously, before native focus can acknowledge a
  // Done agent as idle.
  presentationAgent(agent) {
    const info = this.statusView() && this.presentation?.effective?.[agent?.address];
    return info && (agent.status !== info.status || agent.seq !== info.seq) ? { ...agent, status: info.status, seq: info.seq } : agent;
  }

  applyOverviewAgentClick(agent) {
    if (!agent?.address || !this.statusView()) return;
    const held = this.presentation?.held;
    if (held?.address === agent.address || (!held && agent.status !== "done")) return;
    this.presentation = applyPresentationAction(this.presentation, {
      type: "overview-agent-click",
      address: agent.address,
      status: agent.status,
      seq: agent.seq,
    });
  }

  reduceFrameState() {
    let state = normalizeVisibilityState(this.visibility ?? shared(VISIBILITY_STATE) ?? emptyVisibilityState());
    const queued = actionQueue(shared(VISIBILITY_ACTIONS));
    for (const action of queued) if (action.type !== "reveal-launch") state = this.applyFrameVisibilityAction(state, action);
    const terms = this.frame?.terms ?? [];
    const byAddress = new Map(terms.map((term) => [term.address, term]));
    const previous = this.visibilityFrame ?? new Map();
    const firstFrame = !this.visibilityFrame;
    const revealAddresses = [];
    const pending = [];
    for (const action of queued.filter((item) => item.type === "reveal-launch")) {
      const before = new Set(action.before ?? []);
      const target = terms.find((term) => term.state === "live" && !before.has(term.address)
        && (term.address.includes("/") ? term.address.split("/")[0] : null) === (action.machine ?? null)
        && (term.cwd ?? "").replace(/\/+$/, "") === (action.folder ?? "").replace(/\/+$/, ""));
      if (!target) { pending.push(action); continue; }
      let address = target.address;
      const seen = new Set();
      while (address && !seen.has(address)) {
        seen.add(address);
        revealAddresses.push(address);
        address = byAddress.get(address)?.parent ?? null;
      }
    }
    for (const entry of this.frame?.liveAgents ?? []) {
      const agent = entry.display;
      const term = byAddress.get(entry.address);
      const current = reportedAgentStatus(agent?.status) ?? terminalAgentStatus(term);
      const prior = previous.get(entry.address);
      if (!firstFrame && (current === "working" || current === "blocked") && prior !== current) {
        let address = entry.address;
        const seen = new Set();
        while (address && !seen.has(address)) {
          seen.add(address);
          revealAddresses.push(address);
          address = byAddress.get(address)?.parent ?? null;
        }
      } else if (current === "working" && !isRevealed(state, entry.address, term)) {
        revealAddresses.push(entry.address);
      }
    }
    if (revealAddresses.length) {
      const addresses = [...new Set(revealAddresses)];
      const entries = Object.fromEntries(addresses.map((address) => [address, byAddress.get(address)?.created_ms == null ? {} : { created_ms: byAddress.get(address).created_ms }]));
      state = applyVisibilityAction(state, { type: "reveal", addresses, entries });
    }
    for (const [address, selected] of Object.entries(state.hidden)) {
      const record = selected.recordKey
        ? this.pendingRecovery?.get(selected.recordKey) ?? this.recoveryState().records[selected.recordKey]
        : (this.recoveryCapture ?? []).find((item) => item.address === address);
      if (!record) continue;
      if (!selected.recordKey) state.hidden[address] = { recordKey: record.key, created_ms: record.created_ms };
      if (record.address !== address || selected.created_ms !== record.created_ms) {
        const terminal = terms.find((item) => item.address === record.address);
        if (terminal && findVerifiedRecoveryRecord({ records: { [record.key]: record } }, [{ terminal }])) {
          delete state.hidden[address];
          state.hidden[record.address] = { recordKey: record.key, created_ms: terminal.created_ms };
        }
      }
    }
    if (JSON.stringify(pending) !== JSON.stringify(queued)) setShared(VISIBILITY_ACTIONS, pending);
    state = pruneEnded(state, terms, this.frame?.ms ?? []);
    const computed = withEffective(this.workingSetVisibilityState(state), this.frame?.liveAgents?.map((entry) => entry.display) ?? this.frame?.ag ?? [], terms, this.visibilityLayout());
    computed.groups = state.groups;
    this.visibility = computed;
    this.visibilityFrame = new Map((this.frame?.liveAgents ?? this.frame?.ag ?? []).map((entry) => {
      const agent = entry.display ?? entry;
      return [agent.address, reportedAgentStatus(agent.status) ?? terminalAgentStatus(byAddress.get(agent.address))];
    }));
    const previousState = JSON.stringify(shared(VISIBILITY_STATE));
    if (previousState !== JSON.stringify(state)) setShared(VISIBILITY_STATE, state);
    this.presentation = observePresentation(this.presentation, this.frame?.liveAgents?.map((entry) => entry.display) ?? this.frame?.ag ?? [], terms, this.frame?.ms ?? []);
  }

  applyFrameVisibilityAction(state, action) {
    const next = applyVisibilityAction(state, action);
    if (action.type === "hide-group") {
      const key = action.group?.key ?? action.groupKey ?? action.key;
      for (const address of Object.keys(next.revealed)) {
        if (this.groupKeysForAddress(address).includes(key)) delete next.revealed[address];
      }
    }
    return next;
  }
  setVisibilityAction(action, cx = null) {
    this.visibility = this.applyFrameVisibilityAction(this.visibility, action);
    setShared(VISIBILITY_STATE, this.visibility);
    if (cx) cx.notify();
  }


  groupKeysForAddress(address) {
    if (!address) return [];
    const terms = new Map((this.frame?.terms ?? []).map((term) => [term.address, term]));
    const keys = [];
    const seen = new Set();
    let current = address;
    while (current && !seen.has(current)) {
      seen.add(current);
      let key = null;
      for (const [candidate, rows] of this.frame?.groups ?? []) {
        if ((rows ?? []).some(({ p }) => p.terminal === current)) {
          key = candidate;
          break;
        }
      }
      if (!key) {
        const place = this.workSpace(current)?.id;
        key = place?.startsWith("c:") ? `d:${place.slice(2)}` : place ?? null;
      }
      if (key && !keys.includes(key)) keys.push(key);
      current = terms.get(current)?.parent ?? null;
    }
    return keys;
  }

  groupKeyForAddress(address) {
    return this.groupKeysForAddress(address)[0] ?? null;
  }

  activeWorkingSet() {
    const state = this.workingSets ?? normalizeWorkingSetsState(shared(WORKING_SETS_STATE));
    return state.active ? state.sets[state.active] ?? null : null;
  }

  groupSelector(key) {
    return this.allGroupSelectors().find((item) => (item.nativeKey ?? item.key) === key || item.key === key) ?? null;
  }

  outsideWorkingSet(key) {
    const set = this.activeWorkingSet();
    if (!set || !key) return false;
    const selector = this.groupSelector(key);
    return Boolean(selector && !set.selectors.some((item) => item.key === selector.key || item.nativeKey === selector.nativeKey));
  }

  workingSetVisibilityState(state) {
    const set = this.activeWorkingSet();
    if (!set) return state;
    const transient = applyWorkingSetVisibility(state, set, this.allGroupSelectors());
    // The persisted map contains manual group hides. Working-set exclusions
    // are transient and must never erase or rewrite those rules.
    return { ...transient, groups: { ...(state.groups ?? {}), ...(transient.groups ?? {}) } };
  }

  hiddenGroupKey(key, visual = null) {
    const groups = this.visibilityState().groups ?? {};
    if (groups[key]) return key;
    const target = visual ?? this.frame?.groupMeta?.get?.(key);
    if (!target?.folder) return null;
    return Object.entries(groups).find(([, group]) => group.folder
      && group.folder.replace(/\/+$/, "") === target.folder.replace(/\/+$/, "")
      && (group.machine ?? null) === (target.machine ?? null)
      && group.kind === target.kind)?.[0] ?? null;
  }
  isHiddenGroup(key) {
    if (this.liveAgentsInGroup(key).length) return false;
    return Boolean(key && !this.groupHasRevealed(key) && (this.hiddenGroupKey(key) || this.outsideWorkingSet(key)));
  }
  groupHasRevealed(key) {
    return Boolean(key && (this.frame?.terms ?? []).some((term) => isRevealed(this.visibilityState(), term.address, term)
      && this.groupKeysForAddress(term.address).includes(key)));
  }
  explicitlyHidden(address, terminal = null) {
    return isExplicitlyHidden(this.visibilityState(), address, terminal);
  }

  isHiddenAgent(address) {
    const state = this.visibilityState();
    const term = this.frame?.terms?.find((item) => item.address === address);
    return Boolean(address && !isRevealed(state, address, term) && (
      state.effective?.[address] || this.explicitlyHidden(address, term) || state.groupEffective?.[address]
      || this.groupKeysForAddress(address).some((key) => this.hiddenGroupKey(key) || this.isHiddenGroup(key))
    ));
  }

  visibilityLayout() {
    const groups = {};
    const parents = {};
    for (const [key, rows] of this.frame?.groups ?? []) {
      for (const { p } of rows ?? []) if (p?.terminal) groups[p.terminal] = key;
    }
    for (const entry of this.frame?.liveAgents ?? []) {
      if (entry.visualGroup?.key) groups[entry.address] = entry.visualGroup.key;
      if (entry.parent) parents[entry.address] = entry.parent;
    }
    for (const term of this.frame?.terms ?? []) {
      if (term.parent) parents[term.address] = term.parent;
      if (groups[term.address] !== undefined) continue;
      const place = this.workSpace(term.address)?.id;
      const key = place?.startsWith("c:") ? `d:${place.slice(2)}` : place ?? null;
      if (key) groups[term.address] = key;
    }
    return { groups, parents };
  }

  groupTarget(key, kind, label, machine = null, folder = null) {
    return {
      key,
      kind,
      label: label || key,
      machine: machine ?? null,
      folder: folder ? folder.replace(/\/+$/, "") : null,
    };
  }

  frameGroupVisual(address) {
    for (const [key, rows] of this.frame?.groups ?? []) {
      if ((rows ?? []).some(({ p, terminal }) => p?.terminal === address || terminal === address)) {
        const meta = this.frame?.groupMeta?.get?.(key) ?? this.frame?.groupMeta?.[key] ?? {};
        return { key, ...meta };
      }
    }
    return null;
  }


  hiddenRows() {
    const state = this.visibilityState();
    const rows = [];
    for (const { address, terminal: term, pane, display: agent, ownerSpace: owner, ownerTab: tab, visualGroup: visual } of this.frame.liveAgents) {
      if (term?.state !== "live" || !this.isHiddenAgent(address)) continue;
      const record = (this.recoveryCapture ?? []).find(item => item.address === address);
      const groupKey = this.hiddenGroupKey(visual?.key, visual) ?? visual?.key ?? this.groupKeyForAddress(address);
      const info = state.effective?.[address] ?? state.groupEffective?.[address];
      rows.push({ address, agent, pane, term, record, owner, tab, visual, groupKey,
        inherited: Boolean(info?.inheritedFrom), outsideWorkingSet: Boolean(groupKey && this.outsideWorkingSet(groupKey)) });
    }
    return rows;
  }

  hiddenGroups(precomputedRows = null) {
    const state = this.visibilityState();
    const groups = Object.entries(state.groups ?? {}).map(([key, group]) => ({ key, ...group, workingSet: false }));
    const known = new Set(groups.map((group) => group.key));
    for (const selector of this.allGroupSelectors()) {
      const nativeKey = selector.nativeKey ?? selector.key;
      if (this.outsideWorkingSet(nativeKey) && !known.has(nativeKey)) {
        groups.push({ ...selector, key: nativeKey, workingSet: true });
        known.add(nativeKey);
      }
    }
    const listings = this.hiddenListingsState();
    if (!Object.keys(listings.groups).length) return groups;
    const rows = precomputedRows ?? this.hiddenRows();
    const rowGroups = new Set(rows.map((entry) => groupListingKey(entry.visual ?? { key: entry.groupKey })));
    return groups.filter((group) => !isGroupDismissed(listings, group)
      || rows.some((entry) => entry.groupKey === group.key)
      || rowGroups.has(groupListingKey(group)));
  }

  hiddenSection(t, hiddenSnapshot = null) {
    const rows = hiddenSnapshot?.rows ?? this.hiddenRows();
    const groups = hiddenSnapshot?.groups ?? this.hiddenGroups(rows);
    const count = rows.length + groups.length;
    if (!count) return null;
    const restore = (entry, cx) => {
      const addresses = [];
      const terms = new Map((this.frame?.terms ?? []).map((item) => [item.address, item]));
      const seen = new Set();
      let current = entry.address;
      while (current && !seen.has(current)) {
        seen.add(current);
        addresses.push(current);
        current = terms.get(current)?.parent ?? null;
      }
      this.setVisibilityAction({ type: "reveal", addresses, entries: Object.fromEntries(addresses.map((address) => [address, {}])) }, cx);
      if (entry.pane) {
        if (entry.space && !entry.space.active) run("space.select", { id: entry.space.id });
        if (entry.tab) run("tab.select", { id: entry.tab.id });
        return run("pane.focus", { pane: entry.pane.pane });
      }
      if (entry.term) return run("agent.focus", { terminal: entry.address });
      return null;
    };

    const row = (entry) => {
      const { address, agent, pane, term, record, owner: space, tab, inherited } = entry;
      const name = agentName(agent, tab, pane?.cwd);
      const ownerLabel = space?.name || space?.folder || space?.id;
      const hidden = { kind: "agent", recordKey: record?.key ?? null, address, created_ms: term.created_ms ?? null };
      const focus = () => {
        if (!pane || !space) return run("agent.focus", { terminal: address });
        if (!space.active) run("space.select", { id: space.id });
        if (tab && (!space.active || !tab.active)) run("tab.select", { id: tab.id });
        return run("pane.focus", { pane: pane.pane });
      };
      return h_flex().id(`hidden-agent-${address}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7)
        .hover((s) => s.bg(t.hover)).on_click(focus)
        .on_mouse_down("right", (_event, cx) => { cx.stop_propagation(); this.openHiddenMenu(hidden); })
        .child(h_flex().w(16).flex_none().justify_center().child(this.mark(agent, t, 10)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(name || address))
        .when(Boolean(ownerLabel), el => el.child(div().text_size(10).text_color(t.dim).truncate().tooltip(`Native owner ${ownerLabel}`).child(`↤ ${ownerLabel}`)))
        .when(inherited, el => el.child(div().text_size(10.5).text_color(t.dim).child("Hidden with parent")))
        .when(entry.outsideWorkingSet, el => el.child(div().text_size(10.5).text_color(t.dim).child("Outside working set")))
        .when(!entry.outsideWorkingSet, el => el.child(h_flex().id(`restore-hidden-${address}`).h(20).px(6).flex_none().items_center().rounded(5).cursor_pointer()
          .text_size(11).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); restore({ ...entry, space }, cx); }).child("Restore")))
        .child(this.agentMenuButton(address, t, () => this.openHiddenMenu(hidden)));
    };
    const restoreGroup = (group, members, cx) => {
      const terms = new Map((this.frame?.terms ?? []).map(term => [term.address, term]));
      const addresses = new Set();
      for (const member of members) {
        let address = member.address;
        const seen = new Set();
        while (address && !seen.has(address)) {
          seen.add(address);
          addresses.add(address);
          address = terms.get(address)?.parent ?? null;
        }
      }
      this.setVisibilityAction({ type: "restore-group", groupKey: group.key }, cx);
      if (addresses.size) this.setVisibilityAction({ type: "reveal", addresses: [...addresses], entries: Object.fromEntries([...addresses].map(address => [address, { created_ms: terms.get(address)?.created_ms }])) }, cx);
    };
    const groupRow = (group, members) => {
      const rowCount = members.length;
      const { key, kind, label, machine, folder, workingSet } = group;
      const title = `${kind === "space" ? "Space" : "Project"}: ${label || folder || key}${machine ? ` @ ${machine}` : ""}`;
      const empty = rowCount === 0;
      const action = workingSet
        ? (_e, cx) => { cx.stop_propagation(); this.openWorkingSets(); }
        : empty
          ? (_e, cx) => { cx.stop_propagation(); this.openRecovery(null, { machine, folder, label }); }
          : (_e, cx) => { cx.stop_propagation(); restoreGroup(group, members, cx); };
      const actionLabel = workingSet ? "Working sets" : empty ? "Find saved sessions" : "Restore";
      return h_flex().id(`hidden-group-${key}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("right", (_event, cx) => {
          cx.stop_propagation();
          this.openHiddenMenu({
            kind: "group",
            group: { key, kind, label, machine: machine ?? null, folder: folder ?? null },
          });
        })
        .when(rowCount > 0, (el) => el.cursor_pointer()
          .on_click((_e, cx) => this.toggleSectionFold(`hidden:${key}`, cx)))
        .child(svg(`mods/workspace-chrome/chevron-${this.agentsFolded.has(`hidden:${key}`) ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(svg("mods/workspace-chrome/folder.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(title))
        .when(Boolean(rowCount), (el) => el.child(div().text_size(10).text_color(t.dim).child(String(rowCount))))
        .child(h_flex().id(`${empty ? "find" : "restore"}-hidden-group-${key}`).h(20).px(6).flex_none().items_center().rounded(5).cursor_pointer()
          .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(action).child(actionLabel));
    };
    const grouped = new Map();
    const machineGroup = (machine) => {
      const key = machine ?? null;
      if (!grouped.has(key)) grouped.set(key, new Map());
      return grouped.get(key);
    };
    for (const group of groups) {
      const machine = group.machine ?? null;
      machineGroup(machine).set(group.key, { group, rows: [] });
    }
    for (const entry of rows) {
      const groupKey = entry.groupKey ?? `ungrouped:${entry.address}`;
      const machine = entry.visual?.machine ?? entry.owner?.machine ?? (entry.address.includes("/") ? entry.address.split("/")[0] : null);
      const bucket = machineGroup(machine).get(groupKey) ?? { group: null, rows: [] };
      if (!bucket.group) bucket.group = { key: groupKey, kind: entry.visual?.kind ?? "project", label: entry.visual?.label, folder: entry.visual?.folder, machine };
      bucket.rows.push(entry);
      machineGroup(machine).set(groupKey, bucket);
    }
    const folded = this.agentsFolded.has("section:hidden");
    const machineSections = folded ? [] : [...grouped.entries()].sort(([a], [b]) => String(a ?? "").localeCompare(String(b ?? ""))).map(([machine, buckets]) => {
      const title = machine ?? "This computer";
      const body = [...buckets.values()].sort((a, b) => String(a.group?.label ?? a.group?.key ?? "").localeCompare(String(b.group?.label ?? b.group?.key ?? "")))
        .map((bucket) => v_flex().id(`hidden-group-section-${bucket.group.key}`).flex_none()
          .child(groupRow(bucket.group, bucket.rows))
          .when(!this.agentsFolded.has(`hidden:${bucket.group.key}`), (el) => el.child(v_flex().flex_none().pl(12).children(bucket.rows.map(row)))));
      return v_flex().id(`hidden-machine-${machine ?? "local"}`).flex_none()
        .children([h_flex().h(22).flex_none().px(8).items_center().text_size(10.5).text_color(t.dim).child(title), ...body]);
    });
    const head = h_flex().id("hidden-section").h(28).mt(10).px(8).gap(6).flex_none().items_center().text_size(11.5).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => this.toggleSectionFold("section:hidden", cx))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(10).flex_none())
      .child("Hidden").child(div().text_color(t.dim).child(String(count))).child(div().flex_1())
      .when(Boolean(this.activeWorkingSet()), (el) => el.child(h_flex().id("clear-working-set-hidden").h(20).px(6).flex_none().items_center().rounded(5).cursor_pointer()
        .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.clearWorkingSet(cx); })
        .child("All projects")))
      .child(h_flex().id("restore-hidden-all").h(20).px(6).flex_none().items_center().rounded(5).cursor_pointer()
        .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.clearWorkingSet(cx); this.setVisibilityAction({ type: "restore-all" }, cx); })
        .child("Restore all"));
    return v_flex().id("hidden-agents").flex_none().children([head, ...machineSections]);
  }

  toggleHidden(cx) {
    this.setVisibilityAction({ type: "toggle" }, cx);
  }

  toggleSectionFold(key, cx) {
    this.agentsFolded.has(key) ? this.agentsFolded.delete(key) : this.agentsFolded.add(key);
    localStorage.setItem("agents.folded", JSON.stringify([...this.agentsFolded]));
    cx.notify();
  }


  checkNew(cx) {
    this.persistRecovery();
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    this.resolveTops(cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Closed projects are only looked at while "Not open" is unfolded (each look
  // is four git processes, and there can be a dozen of them).
  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    // Other computers' Not open projects too, while that section is open.
    const remote = Object.entries(this.remote ?? {}).filter(([m]) => this.closedOpenOn?.[m] && this.machines.some((x) => x.name === m && x.state === "connected"))
      .flatMap(([m, f]) => (f.dirs ?? []).filter((d) => !sp.some((s) => s.machine === m && inside((s.folder ?? "").replace(/\/+$/, ""), d))).map((d) => JSON.stringify([m, d])));
    const keys = new Set([...Object.values(at).filter((k) => JSON.parse(k)[1]), ...(this.closedOpen ? this.spaceless(sp) : []).map((d) => JSON.stringify([null, d])), ...(this.loose ?? []).map((d) => JSON.stringify([null, d])), ...remote]);
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  // Agents here that are SSH'd into another computer: each ssh started inside
  // an agent's terminal (it carries HC_TERMINAL_ID; Herdr's own connections
  // don't), its destination matched to a computer Herdr knows (name, ssh host
  // or address, or the same IP: an ssh to 192.168.1.20 is to the laptop there),
  // else the host as typed. Kept a minute after it ends, so a command at a time
  // doesn't flicker.
  async findSsh() {
    const r = await exec("sh", ["-c", SSH_PROCS]).catch(() => null);
    const now = Date.now(), seen = {};
    // Addresses, looked up at most every 5 minutes: each computer's, and each
    // destination that names none of them.
    const addrs = async (name) => {
      const c = (this.ipCache ??= {})[name];
      if (c && now - c.at < 300000) return c.ips;
      const g = await exec("getent", ["ahostsv4", name]).catch(() => null);
      const ips = [...new Set((g?.stdout ?? "").split("\n").map((l) => l.split(/\s+/)[0]).filter(Boolean))];
      this.ipCache[name] = { ips, at: now };
      return ips;
    };
    for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) {
      const [t, cwd, ...args] = line.split("\t");
      const found = sshDestination(args);
      if (!t || !found) continue;
      const { dest, how } = found;
      const host = dest.replace(/^.*@/, "").toLowerCase();
      let m = this.machines.find((x) => [x.name, x.host, x.target, x.target?.replace(/\.local$/i, "")].some((v) => v && v.toLowerCase() === host));
      if (!m) {
        const mine = await addrs(host);
        for (const x of this.machines) if (!m && x.target && (await addrs(x.target)).some((ip) => mine.includes(ip))) m = x;
      }
      // Folders the remote command names ("cd ~/Code/retake && …"): where it works there.
      const rest = args.slice(args.indexOf(dest) + 1).join(" ");
      const paths = [...rest.matchAll(/(?:^|[\s;&|'"=(])((?:~|\/)[^\s;&|'"()]*)/g)].map((x) => x[1].replace(/\/+$/, "") || "/");
      // Started by one of a Claude agent's subagents in a worktree of its own
      // (.claude/worktrees/agent-<id>, its id in subagents.sh): that one's, else
      // the agent's (a subagent without a worktree can't be told apart).
      const sub = /\/\.claude\/worktrees\/(agent-[0-9a-z]+)(\/|$)/.exec(cwd ?? "")?.[1] ?? null;
      // The agent's own (`self`: to, how, cmd, paths) and each subagent's (subs).
      // A command naming no folder (an scp, an sftp) keeps the last one named.
      const to = m?.name ?? dest.replace(/^.*@/, ""), named = paths.length ? paths : null;
      const e = (seen[t] ??= { self: false, subs: [], at: now });
      if (sub) {
        const x = e.subs.find((y) => y.id === sub);
        if (!x) e.subs.push({ id: sub, to, paths: named ?? [] }); else if (named) x.paths = named;
        if (!e.self) e.to ??= to;
      } else {
        Object.assign(e, { self: true, to, how, cmd: args.filter(Boolean).join(" ") });
        if (named) e.paths = named;
      }
    }
    for (const [t, e] of Object.entries(seen)) e.paths ??= this.sshTo?.[t]?.paths ?? [];
    this.sshSeen = now; // the scan whose entries are connected right now
    const was = JSON.stringify(Object.keys(this.sshTo ?? {}));
    this.sshTo = Object.fromEntries(Object.entries({ ...(this.sshTo ?? {}), ...seen }).filter(([, v]) => now - v.at < 60000));
    return JSON.stringify(Object.keys(this.sshTo)) !== was || Object.keys(seen).length > 0; // redraw
  }

  // Over9k's helpers in ~/.local/share/over9k: handoff.sh and resume.sh (the
  // hand-off rule points there), locations.json (Chats and Projects),
  // spaces.json (open spaces by folder, for handoff.sh where no Herdr window
  // runs) and servers.json (this computer's). Written only on change. This
  // computer always gets them; another only while its Automatic hand off is on
  // (over9k-options), which also puts the rule into its CLAUDE.md/AGENTS.md;
  // turned off, the rule and the helpers go again.
  async syncHelpers() {
    const mods = `${appHome()}/mods`;
    this.helperFiles ??= {
      "handoff.sh": await readTextFile(`${mods}/sidebar-overhaul/handoff.sh`).catch(() => null),
      "resume.sh": await readTextFile(`${mods}/sidebar-overhaul/resume.sh`).catch(() => null),
    };
    this.synced ??= {};
    const config = currentSidebarConfig() ?? await sidebarConfig();
    const wanted = config?.options?.computers ?? shared("sidebar.options")?.computers ?? {};
    const connected = this.machines.filter((m) => m.state === "connected" && this.remote[m.name]).map((m) => m.name);
    this.ruleOn ??= {};
    for (const m of connected) {
      const on = Boolean(lookupMachineOption(config, m, "handoffRule", wanted[m]?.handoffRule));
      if (!on && this.ruleOn[m]) {
        await exec("sh", ["-c", 'sh "$HOME/.local/share/over9k/handoff.sh" --rule off; rm -rf "$HOME/.local/share/over9k"'], { on: m }).catch(() => null);
        for (const k of Object.keys(this.synced)) if (k.startsWith(`${m}/`)) delete this.synced[k];
      }
      if (!on) this.ruleOn[m] = false;
    }
    const up = [null, ...connected.filter((m) => lookupMachineOption(config, m, "handoffRule", wanted[m]?.handoffRule))];
    for (const m of up) {
      const loc = { chats: machineLocation(config, m, "chats", "~"), projects: machineLocation(config, m, "projects", "~") };
      const open = Object.fromEntries(this.frame?.sp.filter((s) => (s.machine ?? null) === m && s.folder)
        .map((s) => [s.folder.replace(/\/+$/, ""), m ? s.id.replace(`${m}/`, "") : s.id]) ?? []);
      const files = { ...this.helperFiles, "locations.json": JSON.stringify(loc), "spaces.json": JSON.stringify(open) };
      // This computer's model servers come along for resume.sh.
      if (!m) files["servers.json"] = await readTextFile(`${mods}/over9k-new-menu/servers.json`).catch(() => null);
      for (const [name, text] of Object.entries(files)) {
        const key = `${m ?? ""}/${name}`;
        if (text == null || this.synced[key] === text) continue;
        const r = await exec("sh", ["-c", 'mkdir -p "$HOME/.local/share/over9k" && printf %s "$2" > "$HOME/.local/share/over9k/$1"', "sh", name, text], m ? { on: m } : {}).catch(() => null);
        if (r?.code === 0) this.synced[key] = text;
      }
      // Folders handed off to (handoff.sh lists them in "pin"): pinned, as the
      // menus' Pin does, so they stay listed.
      const p = await exec("sh", ["-c", 'f="$HOME/.local/share/over9k/pin"; [ -s "$f" ] || exit 0; mv "$f" "$f.$$" && cat "$f.$$" && rm -f "$f.$$"'], m ? { on: m } : {}).catch(() => null);
      const handed = (p?.stdout ?? "").split("\n").map((d) => d.trim().replace(/\/+$/, "")).filter(Boolean);
      if (handed.length) this.pinHanded(handed, m);
      // Another computer's rule, once its helpers are there (written again when its folders change).
      const sig = m && JSON.stringify(loc);
      if (m && this.ruleOn[m] !== sig) {
        const r = await exec("sh", ["-c", 'sh "$HOME/.local/share/over9k/handoff.sh" --rule on'], { on: m }).catch(() => null);
        if (r?.code === 0) this.ruleOn[m] = sig;
      }
    }
  }

  // Under another computer: this computer's agents SSH'd into it (findSsh),
  // marked as working from here; a click goes to the agent.
  // `dir`: only those working in that folder there (a space's), else (null)
  // those whose folder matches none of its spaces. Only while connected.
  sshRows(m, t, dir = null) {
    const home = this.remote[m]?.home ?? "";
    const full = (d) => d.replace(/^~(?=\/|$)/, home);
    // Its spaces' folders and its pinned projects' (open or not: busy lifts one).
    const folders = [...this.frame.sp.filter((s) => s.machine === m && s.folder).map((s) => s.folder.replace(/\/+$/, "")), ...this.listedOn(m)];
    // The most specific of those its paths are in (home only for home itself).
    const where = (e) => {
      const hits = (e.paths ?? []).map(full).flatMap((x) => folders.filter((f) => (f === home ? x === f : inside(x, f))));
      return hits.sort((a, b) => b.length - a.length)[0] ?? null;
    };
    // Terminals ssh'd in from here themselves: with a pane (an agent, a shell) or
    // without (something an agent started). Their subagents' get rows of their own.
    const fresh = (address) => { const e = address && this.sshTo?.[address]; return e && e.self && e.to === m && e.at === this.sshSeen && where(e) === dir; };
    const subs = Object.entries(this.subSsh ?? {}).filter(([k, v]) => {
      const [addr, id] = k.split("|");
      return !this.isHiddenAgent(addr) && v.to === m && where(v) === dir && this.subs?.[addr]?.some((x) => x.id === id && !x.done);
    });
    const paneAgentAddress = (p) => {
      const a = this.frame.byPane.get(p.pane);
      const term = (this.frame.terms ?? []).find((k) => k.address === p.terminal);
      return a?.address ?? ((p.program?.agent || agentLike(term)) ? p.terminal : null);
    };
    const panes = this.frame.ps.filter((p) => fresh(p.terminal) && !this.isHiddenAgent(paneAgentAddress(p)));
    const kids = (this.frame.terms ?? []).filter((k) => k.state === "live" && !this.isLiveAgent(k.address) && !this.frame.ps.some((p) => p.terminal === k.address)
      && fresh(k.address) && (!agentLike(k) || !this.isHiddenAgent(k.address)));
    // Where it works there, as its command names it ("cd /tmp/my-app && …"),
    // after its name: from home with ~, under its space's folder from there
    // (nothing when it's the space's own).
    const folderOf = (paths) => {
      const f = full(paths?.[0] ?? "");
      if (!f || f === dir) return null;
      return dir && inside(f, dir) ? f.slice(dir.length + 1) : home && (f === home || inside(f, home)) ? `~${f.slice(home.length)}` : f;
    };
    // One row each, marked with a link chip in its link's colour ("→" then a
    // server); hovering it lights up its row here (and the other way round).
    const linkRow = (address, icon, name, click, kind = BOT, paths = this.sshTo?.[address]?.paths) => {
      const c = this.linkColor(address), folder = folderOf(paths);
      // Lit while its other end is hovered, or the agent it belongs to (its row).
      const on = this.hoverLink?.visitor === address || this.hoverLink?.parent === address.split("|")[0];
      return lit(h_flex().id(`via-${address}`), on && { color: c })
        .h(26).flex_none().pl(4).pr(8).gap(8).items_center().rounded(7).hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => { if (on) this.hoverLink = { color: c, source: address }; else if (this.hoverLink?.source === address) this.hoverLink = null; cx.notify(); })
        .when(Boolean(click), (el) => el.on_click(click))
        .child(h_flex().flex_none().gap(4).items_center().child(div().w(16).flex_none()).child(icon))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(name))
          .when(Boolean(folder), (el) => el.child(div().flex_shrink(0).max_w(170).truncate().text_size(11).text_color(t.dim).child(folder))))
        .child(linkChip(t, `via-chip-${address}`, { dir: "in", icon: kind, color: c }));
    };
    return [
      ...panes.map((p) => {
        const a = this.frame.byPane.get(p.pane);
        const space = this.frame.sp.find((s) => (s.tabs ?? []).some((x) => x.id === p.tab));
        const tab = space?.tabs.find((x) => x.id === p.tab);
        const prog = (a ?? p).program;
        const icon = prog?.icon ? (prog.tint ? svg(prog.icon).size(14).flex_none().text_color(t.foreground) : image(prog.icon).w(14).h(14).flex_none()) : svg("icons/shell.svg").size(14).flex_none().text_color(t.foreground);
        const name = a ? agentName(a, tab, p.cwd) : this.termName(p, tab, "");
        return linkRow(p.terminal, icon, name,
          () => { if (space && !space.active) run("space.select", { id: space.id }); run("pane.focus", { pane: p.pane }); }, a ? BOT : CPU);
      }),
      ...kids.map((k) => {
        const agent = Boolean(k.program?.agent || isAgentProgram(k.agent) || this.frame.ag.some((x) => x.address === k.address));
        return linkRow(k.address, agent ? progIcon(k.program, t, 14) : svg(CPU).size(14).flex_none().text_color(t.foreground), this.nameOf(k.address),
          (_e, cx) => this.showSub(k.address, false, this.nameOf(k.address)), agent ? BOT : CPU);
      }),
      // A subagent by its task; a click shows its transcript, as its row there does.
      ...subs.map(([k, v]) => {
        const [addr, id] = k.split("|"), x = this.subs[addr].find((y) => y.id === id);
        // Its agent's logo (Claude), as its row there has; the chip says it's a subagent.
        const prog = this.frame.ag.find((y) => y.address === addr)?.program;
        return linkRow(k, prog ? progIcon(prog, t, 14) : svg(SUB).size(14).flex_none().text_color(t.foreground), x.desc || "Subagent",
          (e, cx) => this.viewSubagent(addr, id, cx, x.desc || "Subagent", e), SUB, v.paths);
      }),
    ];
  }

  // A computer that has just connected again (or whose folders changed in
  // over9k-options) has its projects looked for again (scanRemote).
  refreshMachines(cx) {
    cx.spawn(async cx => {
      const before = new Set(this.machines.filter((m) => m.state === "connected").map((m) => m.name));
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      const back = this.machines.filter((m) => m.state === "connected" && !before.has(m.name)).map((m) => m.name);
      if (back.length && this.remoteSeen) this.scanRemote(cx, back);
      this.remoteSeen = true;
      this.scanRemote(cx); // only where the folders changed or nothing is known yet
      cx.notify();
    });
  }

  // Every 5 s, one at a time: a run that outlasts the next tick (a big
  // transcript to read) isn't joined by another; one stuck a minute is given up on.
  loadInfo(cx) {
    if (this.infoBusy && Date.now() - this.infoBusy < 60000) return;
    const run = this.infoBusy = Date.now();
    cx.spawn(async (cx) => {
      try {
        const info = {};
        // Herdr's own subagents (hc run, no pane) aren't in agents(): their terminals too.
        const listed = agents();
        // (A terminal says what it runs by its program: "agent" isn't there.)
        const kids = terminals().filter((k) => (k.program?.agent || isAgentProgram(k.agent)) && k.state === "live" && !listed.some((a) => a.address === k.address));
        // Claude Code's and Antigravity's, on each computer that runs one: claude-info.py
        // and agy-info.py there, from each one's own files.
        this.ciScript ??= await readTextFile(`${appHome()}/mods/sidebar-overhaul/claude-info.py`).catch(() => null);
        this.aiScript ??= await readTextFile(`${appHome()}/mods/sidebar-overhaul/agy-info.py`).catch(() => null);
        const ci = {}, ai = {};
        for (const a of [...listed, ...kids]) {
          const [script, into] = isClaude(a) ? [this.ciScript, ci] : isAgy(a) ? [this.aiScript, ai] : [null, null];
          if (!script) continue;
          const [m] = a.address.includes("/") ? a.address.split("/") : [null];
          const key = m ?? "";
          if (key in into || (m && !this.machines.some((x) => x.name === m && x.state === "connected"))) continue;
          const r = await (m ? exec("python3", ["-c", script], { on: m }) : python(["-c", script])).catch(() => null);
          try { into[key] = JSON.parse(r?.stdout || "{}"); } catch { into[key] = {}; }
        }
        for (const a of [...listed, ...kids]) {
          const [m, t] = a.address.includes("/") ? a.address.split("/") : [null, a.address];
          if (m && !(this.remote[m]?.home && this.machines.some((x) => x.name === m && x.state === "connected"))) continue;
          try {
            const found = ci[m ?? ""]?.[t];
            const agy = ai[m ?? ""]?.[t];
            // Antigravity: what its status line saved, if it's on, adds the context
            // (agy's files don't have it readably); the rest from agy-info.py wins.
            const text = found ? null : m ? await readTextFile(`${this.remote[m].home}/.cache/over9k/agents/${t}.json`, { on: m }).catch(() => null)
              : await readTextFile(`${this.infoDir}/${a.address}.json`).catch(() => null);
            let saved = null;
            try { saved = text ? JSON.parse(text) : null; } catch {}
            const merged = agy ? { ...agy, context: saved?.context ?? null, out: saved?.out, lastAt: agy.lastAt ?? saved?.lastAt ?? null } : saved;
            if (found || merged) {
              const i = found ?? merged;
              // Past the prompt cache's expiry (cacheUntil, seconds): the next message re-reads everything.
              i.cold = i.cacheUntil != null && Date.now() / 1000 > i.cacheUntil;
              info[a.address] = i;
            }
          } catch {}
        }
        await this.syncHelpers();
        const ssh = await this.findSsh();
        // Claude Code's subagents, per agent: from its transcript's folder (subagents.sh).
        this.subScript ??= await readTextFile(`${appHome()}/mods/sidebar-overhaul/subagents.sh`).catch(() => null);
        const subs = {};
        for (const [addr, i] of Object.entries(info)) {
          if (!i.transcript) continue;
          const [m] = addr.includes("/") ? addr.split("/") : [null];
          if (!this.subScript) break;
          const r = await exec("sh", ["-c", this.subScript, "sh", i.transcript], m ? { on: m } : {}).catch(() => null);
          const list = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => { const [id, at, desc, type, model, start, tokens, effort, window, done] = l.split("\t"); return { id, at: +at, desc, type, model, start: +start || null, tokens: +tokens || 0, effort: effort || null, window: +window || 200000, done: done === "1" }; });
          if (list.length) subs[addr] = list.sort((x, y) => y.at - x.at);
        }
        // Antigravity's (agy-subagents.py, same lines): the conversations under its own,
        // here only (it reads /proc and agy's databases).
        for (const [addr, i] of Object.entries(info)) {
          if (i.agent !== "antigravity" || addr.includes("/")) continue;
          const r = await python(["-I", `${appHome()}/mods/sidebar-overhaul/agy-subagents.py`, addr, i.conversation ?? ""]).catch(() => null);
          const list = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => { const [id, at, desc, type, model, start, tokens, effort, window, done] = l.split("\t"); return { id, at: +at, desc: sentenceCase(desc), type, model, start: +start || null, tokens: +tokens || 0, effort: effort || null, window: +window || 1048576, done: done === "1" }; });
          if (list.length) subs[addr] = list.sort((x, y) => y.at - x.at);
        }
        // An ssh from the worktree of a subagent that's finished is the running one
        // that carries on there: its transcript names the folder most (others may
        // name it once, in a shared note). Kept while it runs.
        this.wtOwner ??= {};
        for (const [addr, e] of Object.entries(this.sshTo ?? {})) {
          const live = (subs[addr] ?? []).filter((x) => !x.done), dir = info[addr]?.transcript?.replace(/\.jsonl$/, "");
          if (!dir || !e.subs?.length) continue;
          e.subs = await Promise.all(e.subs.map(async (c) => ({ ...c, id: await (async (w) => {
            if (live.some((x) => x.id === w)) return w;
            const key = `${addr}|${w}`, had = this.wtOwner[key];
            if (had && live.some((x) => x.id === had)) return had;
            const r = live.length ? await exec("grep", ["-c", "-F", w, ...live.map((x) => `${dir}/subagents/${x.id}.jsonl`), "/dev/null"]).catch(() => null) : null;
            const counts = (r?.stdout ?? "").split("\n").map((l) => /([^/]+)\.jsonl:(\d+)$/.exec(l)).filter((m) => m && +m[2] > 1).sort((x, y) => y[2] - x[2]);
            const owner = counts[0]?.[1];
            if (owner) this.wtOwner[key] = owner;
            return owner ?? w;
          })(c.id) })));
        }
        // Each subagent's last ssh, kept a minute: tests ssh one command at a time.
        const at = Date.now();
        this.subSsh = Object.fromEntries(Object.entries(this.subSsh ?? {}).filter(([, v]) => at - v.at < 60000));
        for (const [addr, e] of Object.entries(this.sshTo ?? {})) if (e.at === this.sshSeen) for (const c of e.subs ?? []) {
          const key = `${addr}|${c.id}`;
          this.subSsh[key] = { to: c.to, paths: c.paths.length ? c.paths : (this.subSsh[key]?.paths ?? []), at };
        }
        // And what each has running in the background, or scheduled (tasks.sh):
        // its shells and monitors (processes too) and its cron jobs.
        this.taskScript ??= await readTextFile(`${appHome()}/mods/sidebar-overhaul/tasks.sh`).catch(() => null);
        const tasks = {};
        for (const [addr, i] of Object.entries(info)) {
          if (!i.transcript || !this.taskScript) continue;
          const [m] = addr.includes("/") ? addr.split("/") : [null];
          const r = await exec("sh", ["-c", this.taskScript, "sh", i.transcript], m ? { on: m } : {}).catch(() => null);
          const list = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => { const [kind, id, desc, start, schedule, output] = l.split("\t"); return { kind, id, desc, start: +start || null, schedule: schedule || null, output: output || null }; });
          if (list.length) tasks[addr] = list;
        }
        // A Codex agent's own subagents and running commands (codex.sh), here or on
        // the agent's computer.
        this.codexScript ??= await readTextFile(`${appHome()}/mods/sidebar-overhaul/codex.sh`).catch(() => null);
        for (const a of [...listed, ...kids].filter((x) => isCodex(x) || /^codex/.test(x.agent ?? ""))) {
          if (!this.codexScript) break;
          const [m, t] = a.address.includes("/") ? a.address.split("/") : [null, a.address];
          const r = await exec("sh", ["-c", this.codexScript, "sh", t], m ? { on: m } : {}).catch(() => null);
          const list = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => { const [kind, id, desc, start, schedule] = l.split("\t"); return { kind, id, desc, start: +start || null, schedule: schedule || null, output: null }; });
          if (list.length) tasks[a.address] = [...(tasks[a.address] ?? []), ...list];
        }
        const subsChanged = JSON.stringify([subs, tasks]) !== JSON.stringify([this.subs ?? {}, this.tasks ?? {}]);
        this.subs = subs;
        this.tasks = tasks;
        // What's gone is forgotten: when started terminals were first seen, viewers kept.
        const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
        for (const k of Object.keys(this.kidSeen ?? {})) if (!live.has(k)) delete this.kidSeen[k];
        for (const [k, v] of Object.entries(this.viewers ?? {})) if (!live.has(v)) delete this.viewers[k];
        // This computer's folders changed (over9k-options): look again.
        if (this.scannedWith !== JSON.stringify(localScanSettings(currentSidebarConfig()))) this.scanProjects(cx);
        // An agent that was working and now isn't: it just finished.
        let finished = false;
        for (const a of agents()) {
          if (a.status === "working") this.wasWorking[a.address] = true;
          else if (this.wasWorking[a.address]) { delete this.wasWorking[a.address]; this.lastWork[a.address] = Date.now(); finished = true; }
        }
        if (finished) {
          const live = new Set(agents().map((a) => a.address));
          for (const k of Object.keys(this.lastWork)) if (!live.has(k)) delete this.lastWork[k];
          localStorage.setItem("agents.lastWork", JSON.stringify(this.lastWork));
        }
        // Pi's model, thinking level and context: its footer, per terminal.
        const pi = {};
        for (const a of agents()) {
          if (!isPi(a)) continue;
          const r = await hc(["read", a.address, "--lines", "8"]).catch(() => null);
          const f = piFooter(r?.stdout);
          if (f) pi[a.address] = f;
        }
        // Models by id from Pi's list (~/.pi/agent/models.json): their names and
        // servers; a server here runs at the effort its command line gives.
        const models = {};
        try {
          const list = JSON.parse(await readTextFile(`${homeDir()}/.pi/agent/models.json`));
          for (const prov of Object.values(list.providers ?? {}))
            for (const m of prov.models ?? []) {
              const port = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(prov.baseUrl ?? "")?.[1] ?? null;
              models[m.id] = { name: (m.name ?? m.id).replace(/\s*\(local\)$/i, ""), port };
            }
        } catch {}
        // Servers here for those models: running (pid by port), and their effort.
        const effort = {}, up = {};
        const ports = new Set(Object.values(models).map((m) => m.port).filter(Boolean));
        if (ports.size) {
          const r = await exec("ps", ["-eo", "pid=,args="]).catch(() => null);
          for (const line of (r?.stdout ?? "").split("\n")) {
            const port = /--port\s+(\d+)/.exec(line)?.[1], e = /--reasoning-effort\s+(\S+)/.exec(line)?.[1];
            if (!port || !ports.has(port) || /<defunct>/.test(line)) continue;
            up[port] = Number(line.trim().split(/\s+/)[0]);
            if (e) effort[port] = e;
          }
        }
        const next = JSON.stringify([info, pi, models, effort, up]);
        if (next !== JSON.stringify([this.info, this.piInfo, this.models, this.serverEffort, this.serversUp])) {
          this.info = info; this.piInfo = pi; this.models = models; this.serverEffort = effort; this.serversUp = up;
          cx.notify();
        } else if (ssh || subsChanged || Object.values(subs).some((l) => l.some((x) => Date.now() / 1000 - x.at < 70))) {
          cx.notify(); // a connection started, is still going, or ended
        }
      } finally { if (this.infoBusy === run) this.infoBusy = 0; }
    });
  }

  // A chip on This computer's heading per local model server running (its
  // model's logo and name): it's holding the GPU. Hovered it reads "Stop …";
  // a click asks first (over9k-server-stop), naming the agents on that model.
  serverChips(t) {
    return Object.entries(this.serversUp).map(([port, pid]) => {
      const m = Object.values(this.models).find((x) => x.port === port);
      const fam = FAMILY.find((f) => f.match.test(m?.name ?? ""));
      const armed = this.hoverServer === port;
      return h_flex().id(`server-${port}`).h(18).px(5).gap(4).flex_none().rounded(5).items_center().cursor_pointer()
        .border(1).border_color(armed ? t.ansi1 : t.border).text_size(10.5).text_color(armed ? t.ansi1 : t.dim)
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => { if (on) this.hoverServer = port; else if (this.hoverServer === port) this.hoverServer = null; cx.notify(); })
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.hoverServer = null; this.askStop(port, pid, m?.name ?? `port ${port}`, cx); })
        .when(Boolean(fam), (el) => el.child(svg(fam?.icon ?? "").size(10).text_color(fam?.color)))
        .child(armed ? `Stop ${(m?.name ?? "server").split(" ")[0]}` : (m?.name ?? `:${port}`).split(" ")[0]);
    });
  }

  askStop(port, pid, name, cx) {
    cx.spawn(async () => {
      let stop = null;
      try {
        const entry = JSON.parse(await readTextFile(`${appHome()}/mods/sidebar-overhaul/servers.json`))[`http://127.0.0.1:${port}`];
        stop = typeof entry === "object" ? entry?.stop : null;
      } catch {}
      // The agents on a model this server holds, by the names the rows show.
      const users = agents().filter((a) => {
        const raw = isCodex(a) ? codexTitle(a.title) : isPi(a) ? this.piInfo[a.address] : this.info[a.address];
        return raw && (this.models[raw.id] ?? this.models[raw.model])?.port === port;
      }).map((a) => agentTask(a, this.frame?.ps.find((p) => p.terminal === a.address)?.cwd) || appName(a) || a.address);
      openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 400, height: 170, props: { name, port, pid, stop, agents: users, view: "server-stop" } });
    });
  }

  // How long ago an agent last worked: "3m", "2h", "1d" (null when unknown).
  since(a, i) {
    const at = Math.max(this.lastWork[a.address] ?? 0, (i?.lastAt ?? 0) * 1000);
    if (!at) return null;
    const m = Math.max(0, Math.round((Date.now() - at) / 60000));
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  }

  // An agent's info with its model named: one from Pi's list goes by its name
  // and family logo, and Claude Code on a local server by that server's effort.
  withModel(i, a) {
    const m = this.models[i.id] ?? this.models[i.model];
    if (!m) return i;
    const fam = FAMILY.find((f) => f.match.test(`${i.model} ${m.name}`));
    return { ...i, model: m.name, family: fam ?? null, effort: (isClaude(a) && m.port && this.serverEffort[m.port]) || i.effort };
  }

  // "Opus 5.5 · high · 24% · 3m" after the agent's name: model, effort, context
  // used (its percent green, yellow from 50%, red from 80%; "medium" shows as
  // "med", a purple * after it while ultracode is on), time since it last
  // worked; then a red "exp."
  // once the prompt cache has run out. Clicking it starts over (freshStart);
  // hovering says so ("clear + recap").
  // What shows is up to over9k-options (o): each item, joined by dots.
  // How many agents, subagents and processes an agent has started (BOT / SUB / CPU), a
  // click shows or hides them (subRows); hovered, in words.
  subsChip(a, p, t) {
    const id = `subs-${a.address}`;
    const chevron = () => svg(`mods/workspace-chrome/chevron-${this.subsOpen.has(a?.address) ? "down" : "right"}.svg`).size(8);
    // White (the theme's text colour) on a faint wash of it.
    const fg = t.foreground, wash = (a) => (/^#[0-9a-f]{6}$/i.test(fg) ? fg + a : t.raised);
    const chip = () => h_flex().h(16).px(4).gap(3).items_center().rounded(4).text_size(10.5).text_color(fg);
    const n = this.subCounts(a);
    // An icon and count for each kind it has (compact: just how many in all); a
    // click shows or hides them (subRows).
    const compact = this.frame.options.layout === "compact";
    // A dot (its link's colour) for each of its subagents ssh'd into another
    // computer; the agent's own shows as its link chip.
    const away = (this.subs?.[a.address] ?? []).filter((x) => !x.done && this.sshedTo(a.address, x.id)).slice(0, 3).map((x) => this.linkColor(`${a.address}|${x.id}`));
    return div().id(id).flex_none()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.subsOpen.has(a.address) ? this.subsOpen.delete(a.address) : this.subsOpen.add(a.address);
        localStorage.setItem("agents.subsOpen", JSON.stringify([...this.subsOpen]));
        cx.notify();
      })
      // Brighter while its row is hovered (a click anywhere on the row folds it too).
      .child(chip().bg(wash(this.hoverTerm === p.pane ? "29" : "1a"))
        .when(compact, (el) => el.child(String(n.agents + n.inner + n.processes + n.crons)))
        .when(!compact && n.agents > 0, (el) => el.child(svg(BOT).size(10).flex_none()).child(String(n.agents)))
        .when(!compact && n.inner > 0, (el) => el.child(svg(SUB).size(13).flex_none().ml(n.agents > 0 ? 3 : 0)).child(String(n.inner)))
        .when(!compact && n.processes > 0, (el) => el.child(svg(CPU).size(10).flex_none().ml(n.agents + n.inner > 0 ? 3 : 0)).child(String(n.processes)))
        .when(!compact && n.crons > 0, (el) => el.child(svg(CLOCK).size(10).flex_none().ml(n.agents + n.inner + n.processes > 0 ? 3 : 0)).child(String(n.crons)))
        .children(away.map((c, i) => div().size(5).rounded(3).flex_none().bg(c).when(i === 0, (el) => el.ml(1))))
        .child(chevron()));
  }

  // An agent row's details and its subagents chip. `withChip` false: the row
  // shows the chip elsewhere (expanded, at its end).
  // What goes at the end of an agent row: its link chip when it also works on
  // another computer (ssh'd there: findSsh; listed there too, sshRows, and
  // hovering either row lights up the other), then its count chip.
  endChips(a, p, t) {
    const to = this.sshedTo(p.terminal, "self");
    const els = [
      to && linkChip(t, `ssh-${p.terminal}`, { dir: "out", icon: a ? BOT : CPU, color: this.linkColor(p.terminal), to }),
      a && this.subCount(a) > 0 && this.subsChip(a, p, t),
    ].filter(Boolean);
    return els.length ? h_flex().flex_none().gap(5).items_center().children(els) : null;
  }

  agentDetails(info, t, a, p, opt, withChip = true) {
    const chip = withChip ? this.endChips(a, p, t) : null;
    return this.infoLine(info, t, a.address, agentTask(a, p.cwd), opt, chip);
  }

  // `extra`: an element at the end of the line (an agent's subagents chip).
  infoLine(i, t, terminal, name, o, extra = null) {
    const pct = Math.round(i.context ?? 0);
    const color = pct >= 80 ? t.ansi1 : pct >= 50 ? t.ansi3 : t.ansi2;
    const parts = [
      // Listed by state (agentSections): its folder in a readable secondary
      // text colour, and the computer when it's another.
      this.tagWhere ? div().text_color(t.muted).child(this.tagWhere.folder) : null,
      this.tagWhere?.machine ? div().child(this.tagWhere.machine) : null,
      o.model && i.model ? div().child(i.model) : null,
      o.effort && i.effort ? h_flex().items_center().child(i.effort === "medium" ? "med" : i.effort)
        .when(Boolean(i.ultracode), (el) => el.child(div().text_color(MARK.ansi5).child("*"))) : null,
      // Context always shows when on: 0% before the first reply.
      o.context ? div().text_color(color).child(`${pct}%`) : null,
      // How long since it last worked, while it isn't.
      o.since && i.since ? div().child(i.since) : null,
    ].filter(Boolean);
    return h_flex().flex_none().items_center().text_size(11).text_color(t.dim)
      .children(dotted(parts))
      .when(Boolean(o.cache && i.cold), (el) => el.child(div().id(`exp-${terminal}`).ml(4).px(2).rounded(4).cursor_pointer().text_color(t.ansi1)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_hover((on, cx) => { if (on) this.hoverExp = terminal; else if (this.hoverExp === terminal) this.hoverExp = null; cx.notify(); })
        .on_click((_e, cx) => { cx.stop_propagation(); this.freshStart(terminal, i.transcript, name, cx); })
        .child(this.hoverExp === terminal ? "clear + recap" : "exp.")))
      .when(Boolean(extra), (el) => el.child(extra.ml(5)));
  }

  // With the cache gone the next message pays for the whole conversation again,
  // so start a new one (/clear) and have it read the old transcript for context.
  // The old one is renamed "[Cleared] <name>" first, so Claude's own /resume
  // picker tells them apart. The new one is named from the first line of
  // Claude's recap ("Name: ..."): its automatic title would only be about
  // reading a transcript, and carrying that forward named every one the same.
  freshStart(terminal, transcript, name, cx) {
    // An automatic title taken from an earlier recap prompt says nothing.
    if (name && /transcript recap/i.test(name)) name = null;
    cx.spawn(async (cx) => {
      if (name) {
        await hc(["send", terminal, `/rename [Cleared] ${name}`]).catch(() => null);
        await cx.sleep(800);
      }
      await hc(["send", terminal, "/clear"]).catch(() => null);
      if (!transcript) return;
      // A prompt sent before /clear finishes is lost: wait until claude-info.py
      // reports the new conversation's transcript (up to 35s), then a moment more.
      let fresh = null;
      for (let n = 0; n < 70; n++) {
        await cx.sleep(500);
        const now = await readTextFile(`${this.infoDir}/${terminal}.json`).catch(() => null);
        try { fresh = now && JSON.parse(now).transcript; } catch { fresh = null; }
        if (fresh && fresh !== transcript) break;
        fresh = null;
      }
      await cx.sleep(500);
      await hc(["send", terminal, `We just cleared the conversation because its prompt cache expired. For context, read the previous conversation's transcript at ${transcript} (JSONL; mostly its last part: what I asked, what was done, what's still open). Start your reply with one line "Name: <3 to 5 words naming what we're working on>" (it becomes this session's name), then tell me in a few lines where we left off, and wait for my next message.`]).catch(() => null);
      if (!fresh) return;
      // Watch for the reply (up to 5 minutes) and rename as soon as it lands,
      // before there's much chance of a half-typed message for /rename to join.
      for (let n = 0; n < 300; n++) {
        await cx.sleep(1000);
        const got = recapName(await readTextFile(fresh).catch(() => null));
        if (!got) continue;
        await hc(["send", terminal, `/rename ${got}`]).catch(() => null);
        return;
      }
    });
  }

  // Which row each terminal lists under: the space or visual project its live
  // pane folder is in. `space` on each row remains the native owner for focus
  // and close actions; `visual` is only for grouping, labels and visibility.
  // Canonical live agents are the union of the native agent snapshot and
  // status-reporting agent-like terminals.  The projection is deliberately
  // made from copies: native snapshots stay immutable for visibility and
  // presentation observers.
  canonicalLiveAgents(sp, ps, listed, terms) {
    const panesByAddress = new Map(ps.filter((p) => p?.terminal).map((p) => [p.terminal, p]));
    const terminalsByAddress = new Map(terms.filter((term) => term?.address).map((term) => [term.address, term]));
    const agentsByAddress = new Map(listed.filter((agent) => agent?.address).map((agent) => [agent.address, agent]));
    const addresses = new Set(agentsByAddress.keys());
    for (const term of terms) {
      if (term?.state !== "live" || !term.address) continue;
      if (agentLike(term)) addresses.add(term.address);
    }
    const spaceByTab = new Map();
    for (const space of sp) for (const tab of space.tabs ?? []) spaceByTab.set(tab.id, space);
    const machineOf = (address) => typeof address === "string" && address.includes("/") ? address.split("/", 1)[0] : null;
    const trim = (value) => typeof value === "string" ? value.replace(/\/+$/, "") : "";
    const labelValue = (labels, key) => labels?.[key] ?? labels?.[`herdr.${key}`] ?? labels?.[`revive.${key}`] ?? null;
    const labelSpace = (value, machine) => {
      if (!value) return null;
      const text = String(value).replace(/^([^/]+)\//, (match, prefix) => prefix === machine ? "" : match);
      return sp.find((space) => (space.machine ?? null) === machine && (space.id === value || space.id === text
        || space.id?.split("/").pop() === text || space.name === text || trim(space.folder) === trim(text))) ?? null;
    };
    const labelTab = (value, machine) => {
      if (!value) return null;
      const text = String(value).replace(/^([^/]+)\//, (match, prefix) => prefix === machine ? "" : match);
      for (const space of sp) {
        if ((space.machine ?? null) !== machine) continue;
        const tab = (space.tabs ?? []).find((item) => item.id === value || item.id === text
          || item.id?.split("/").pop() === text || item.name === text);
        if (tab) return { space, tab };
      }
      return null;
    };
    const byAddress = new Map();
    const resolving = new Set();
    const build = (address) => {
      if (byAddress.has(address)) return byAddress.get(address);
      if (resolving.has(address)) return null;
      resolving.add(address);
      const agent = agentsByAddress.get(address) ?? null;
      const terminal = terminalsByAddress.get(address) ?? null;
      const pane = panesByAddress.get(address) ?? null;
      const machine = machineOf(address);
      const merged = { ...(terminal ?? {}), ...(agent ?? {}) };
      for (const key of ["parent", "cwd", "program", "labels", "created_ms", "report"]) if (terminal?.[key] != null && merged[key] == null) merged[key] = terminal[key];
      if (merged.status == null) merged.status = terminalAgentStatus(terminal) ?? "idle";
      const parent = terminal?.parent ?? agent?.parent ?? null;
      let ownerSpace = pane ? spaceByTab.get(pane.tab) ?? null : null;
      let ownerTab = pane && ownerSpace ? (ownerSpace.tabs ?? []).find((tab) => tab.id === pane.tab) ?? null : null;
      const labels = { ...(agent?.labels ?? {}), ...(terminal?.labels ?? {}) };
      if (!ownerSpace) {
        const labeledTab = labelTab(labelValue(labels, "tab") ?? agent?.tab ?? agent?.tab_id, machine);
        const labeledSpace = labelSpace(labelValue(labels, "space") ?? agent?.space ?? agent?.space_id ?? agent?.space_name, machine);
        ownerSpace = labeledTab?.space ?? labeledSpace;
        ownerTab = labeledTab?.tab ?? null;
      }
      if (!ownerSpace && parent) {
        const parentEntry = build(parent);
        ownerSpace = parentEntry?.ownerSpace ?? null;
        ownerTab = parentEntry?.ownerTab ?? null;
      }
      const cwd = trim(pane?.cwd ?? merged.cwd);
      if (!ownerSpace && cwd) {
        ownerSpace = sp.filter((space) => (space.machine ?? null) === machine && space.folder && inside(cwd, trim(space.folder)))
          .sort((a, b) => trim(b.folder).length - trim(a.folder).length)[0] ?? null;
        ownerTab = ownerSpace?.tabs?.[0] ?? null;
      }
      const projects = machine ? [...new Set([...this.listedOn(machine), ...(this.remote[machine]?.dirs ?? [])])] : this.projects;
      const homeSpace = machine ? null : sp.find((space) => !space.machine && trim(space.folder) === homeDir());
      const visual = visualGroupForPane({
        pane: pane ?? { terminal: address, cwd, program: merged.program },
        owner: ownerSpace,
        spaces: sp,
        projects,
        homeSpace,
        fallbackFolder: cwd || (machine ? this.remote[machine]?.home : homeDir()),
      });
      const visualGroup = visual.group ?? (ownerSpace ? {
        key: ownerSpace.id, kind: "space", label: ownerSpace.name, folder: trim(ownerSpace.folder), machine: ownerSpace.machine ?? null,
      } : {
        key: folderGroupKey(machine, cwd || (machine ? this.remote[machine]?.home : homeDir())),
        kind: "project", label: base(cwd || (machine ? this.remote[machine]?.home : homeDir())),
        folder: trim(cwd || (machine ? this.remote[machine]?.home : homeDir())), machine,
      });
      const entry = {
        address, terminal, agent, pane, ownerSpace, ownerTab, visualGroup, machine,
        parent, cwd, status: reportedAgentStatus(agent?.status) ?? terminalAgentStatus(terminal) ?? "idle",
        seq: agent?.seq ?? terminal?.seq ?? terminal?.report?.seq ?? 0,
        display: { ...merged, address, parent, cwd, status: reportedAgentStatus(agent?.status) ?? terminalAgentStatus(terminal) ?? "idle", seq: agent?.seq ?? terminal?.seq ?? terminal?.report?.seq ?? 0 },
      };
      byAddress.set(address, entry);
      resolving.delete(address);
      return entry;
    };
    for (const address of addresses) build(address);
    return [...byAddress.values()].filter((entry) => entry.terminal ? entry.terminal.state === "live" : entry.agent);
  }

  indexLiveAgents(liveAgents, groups) {
    const liveByAddress = new Map(liveAgents.map((entry) => [entry.address, entry]));
    const liveGroups = new Map();
    for (const entry of liveAgents) {
      const key = entry.visualGroup?.key;
      if (!key) continue;
      const meta = entry.visualGroup;
      if (!this.groupMeta.has(key)) this.groupMeta.set(key, meta);
      if (!groups.has(key)) groups.set(key, []);
      if (!liveGroups.has(key)) liveGroups.set(key, []);
      liveGroups.get(key).push(entry);
    }
    this.frame.liveAgentByAddress = liveByAddress;
    this.frame.liveGroups = liveGroups;
    return liveByAddress;
  }

  isLiveAgent(address) {
    return Boolean(address && this.frame?.liveAgentByAddress?.has(address));
  }

  visibleAgentsInGroup(key) {
    return this.liveAgentsInGroup(key).filter((entry) => !this.isHiddenAgent(entry.address));
  }

  groupHasVisibleContent(key) {
    if (this.visibleAgentsInGroup(key).length) return true;
    const terms = new Map((this.frame?.terms ?? []).map((term) => [term.address, term]));
    return (this.frame?.groups?.get(key) ?? []).some(({ p }) => {
      if (!p?.terminal) return false;
      const agent = this.frame?.byPane?.get(p.pane);
      const term = terms.get(p.terminal);
      const address = agent?.address ?? (agentLike(term) ? term.address : null);
      return !address || !this.isHiddenAgent(address);
    });
  }
  liveAgentsInGroup(key) {
    return this.frame?.liveGroups?.get(key) ?? [];
  }

  liveAgentRowsForGroup(key, t, indent = 0) {
    return this.liveAgentsInGroup(key).filter(entry => !this.isHiddenAgent(entry.address)).map((entry) => this.liveAgentRow(entry, t, indent)).filter(Boolean);
  }


  liveAgentRow(entry, t, indent = 0) {
    if (this.isHiddenAgent(entry.address)) return null;
    if (entry.pane && entry.visualGroup?.key) {
      const row = this.termRows(entry.visualGroup.key, t, indent, entry.address, false)[0];
      if (row) return row;
    }
    const raw = entry.display ?? entry.agent ?? entry.terminal ?? { address: entry.address };
    const shown = this.presentationAgent(raw) ?? raw;
    const task = agentTask(shown, entry.cwd) || shown.name || shown.program?.name || shown.agent || entry.address;
    const idle = shown.status === "idle" || shown.status === "done" || shown.status === "inactive";
    const folder = entry.visualGroup?.folder ? this.where(entry.visualGroup.folder, entry.machine) : null;
    const machine = entry.machine;
    const click = (e, cx) => {
      if (multi(e)) return this.pick(entry.pane ? `p:${entry.pane.pane}` : `a:${entry.address}`, cx, e);
      this.applyOverviewAgentClick(shown);
      const hadSelection = this.sel.size > 0;
      this.sel.clear();
      this.anchor = entry.pane ? `p:${entry.pane.pane}` : `a:${entry.address}`;
      if (entry.pane) run("pane.focus", { pane: entry.pane.pane });
      else run("terminal.peek", { terminal: entry.address });
      if (hadSelection) cx.notify();
    };
    return h_flex().id(`agent-${entry.address}`).h(folder || machine ? 36 : 26).flex_none().pl(4 + indent).pr(8).gap(8).items_center().rounded(7)
      .when(this.frame.focusedTerminal === entry.address, el => el.bg(t.selected))
      .hover((s) => s.bg(this.frame.focusedTerminal === entry.address ? t.selected : t.hover)).on_click(click)
      .child(h_flex().w(16).flex_none().justify_center().child(this.mark(shown, t)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_size(12.5).text_color(!idle || this.frame.focusedTerminal === entry.address ? t.foreground : t.muted).child(task))
        .when(Boolean(folder || machine), (el) => el.child(h_flex().min_w(0).items_center().gap(5).text_size(11).text_color(t.dim)
          .child(div().min_w(0).truncate().child(folder ?? "~"))
          .when(Boolean(machine), (x) => x.child(div().truncate().child(machine)))))
      ).child(this.agentMenuButton(entry.address, t));
  }

   // Which row each terminal lists under: the space or visual project its live
  assign(sp, ps) {
    const spaceOfTab = new Map();
    for (const s of sp) for (const tab of s.tabs ?? []) spaceOfTab.set(tab.id, s);
    const local = sp.filter((s) => !s.machine);
    const trim = (d) => (d ?? "").replace(/\/+$/, "");
    const homeSpace = local.find((s) => trim(s.folder) === homeDir());
    const remoteProjects = new Map();
    const projectsFor = (machine) => {
      if (!machine) return this.projects;
      if (!remoteProjects.has(machine)) remoteProjects.set(machine, [...new Set([...this.listedOn(machine), ...(this.remote[machine]?.dirs ?? [])])]);
      return remoteProjects.get(machine);
    };
    const groups = new Map();
    this.groupMeta = new Map();
    this.wantTops = new Set();
    for (const p of ps) {
      const mine = p.terminal && spaceOfTab.get(p.tab);
      if (!mine) continue;
      const cwd = trim(p.cwd) || null;
      const visual = visualGroupForPane({
        pane: p,
        owner: mine,
        spaces: sp,
        projects: projectsFor(mine.machine ?? null),
        homeSpace: mine.machine ? null : homeSpace,
        fallbackFolder: !mine.machine && cwd ? (this.tops.get(cwd) ?? cwd) : cwd,
      });
      if (!mine.machine && cwd && !visual.matched && !this.tops.has(cwd)) this.wantTops.add(cwd);
      const key = visual.key ?? mine.id;
      if (!groups.has(key)) groups.set(key, []);
      if (visual.group && !this.groupMeta.has(key)) this.groupMeta.set(key, visual.group);
      groups.get(key).push({
        p,
        space: mine,
        tab: mine.tabs.find((x) => x.id === p.tab),
        visual: visual.group,
      });
    }
    return groups;
  }

  // A row's terminals: status, icon, name, and for an agent its model · effort ·
  // context % when known. Click shows it; Ctrl+click picks it to close. A
  // worktree's terminals sit one step further in than the worktree row.
  termRows(key, t, indent = 0, onlyAddress = null, includeLive = true) {
    const { byPane, liveTerminals: live } = this.frame;
    // Something an agent started (open beside it) is listed under that agent
    // (subRows), not again on its own, while the agent runs.
    const child = (term) => Boolean(live.get(term)?.parent && live.has(live.get(term).parent))
      // A subagent's or a process's live view (view()) too: its row is under the agent.
      || live.get(term)?.labels?.over9k === "view" || Object.values(this.viewers ?? {}).includes(term);
    return [...(includeLive ? this.liveAgentRowsForGroup(key, t, indent) : []), ...(this.frame.groups.get(key) ?? []).filter(({ p }) => {
       const a = byPane.get(p.pane), term = live.get(p.terminal);
       const address = a?.address ?? (agentLike(term) ? term.address : null);
      if (onlyAddress) return address === onlyAddress;
      return !this.isLiveAgent(address) && this.passes(a) && !this.isHiddenAgent(address) && !child(p.terminal) && (!this.onlyPane || p.pane === this.onlyPane);
    }).flatMap(({ p, space, tab }) => {
      this.vis.push(`p:${p.pane}`);
      const rawAgent = byPane.get(p.pane);
      const a = this.presentationAgent(rawAgent);
      const idle = !a || a.status === "idle" || a.status === "done" || a.status === "inactive";
      // Claude Code's status line writes its info to a file; Codex's is in its title.
      const codex = a && isCodex(a) ? codexTitle(a.title) : null;
      const raw = a && (codex ? (codex.model ? codex : null) : isPi(a) ? this.piInfo[a.address] : this.info[a.address]);
      const info = raw && { ...this.withModel(raw, a), since: a.status !== "working" ? this.since(a, raw) : null };
      // Two lines (name, then details): expanded, or listed by state (agentSections:
      // its folder leads the second line, then the details).
      const opt = this.frame.options, two = Boolean(this.tagWhere) || (info && opt.layout === "expanded");
      const ownership = this.ownershipBadge({ owner: { id: space.id, name: space.name, folder: space.folder }, visual: this.frameGroupVisual(p.terminal) }, t);
      // Picked itself, or going with a picked space (its own) or visual folder row.
      const picked = this.sel.has(`p:${p.pane}`) || this.sel.has(`s:${space.id}`)
        || ((key.startsWith("d:") || key.startsWith("r:")) && this.sel.has(key));
      // Expanded (over9k-options): an agent with info takes two lines, its name
      // then the info under it; compact keeps the info on the name's line.
      // Its two lines sit close (tight line heights), with room above and below.
      // SSH'd elsewhere: lit while its row there is hovered, and hovering it lights that one (sshRows).
      const sshed = this.sshedTo(p.terminal, "self");
      // Native hover paints the row. Only linked rows or a subagent chip need a JS redraw.
      const linkedHover = sshed || (a && this.subCount(a) > 0);
      const active = this.frame.focusedTerminal === p.terminal && (this.frame.focus?.shown || !this.frame.focus?.pane || this.frame.focus.pane === p.pane);
      const row = lit(h_flex().id(`term-${p.terminal}`), this.hoverLink?.source === p.terminal && this.hoverLink).h(two ? 36 : 26).flex_none().pl(4 + indent).pr(8).gap(8).items_center().rounded(7).relative().overflow_hidden()
        .when(active && !picked, (el) => el.bg(t.selected)
          .child(div().absolute().left(0).top(0).bottom(0).w(2).bg(t.accent)))
        .when(picked, (el) => el.bg(t.accent + "38"))
        .hover((s) => s.bg(active && !picked ? t.selected : t.hover))
        .when(Boolean(linkedHover), el => el.on_hover((on, cx) => {
          if (on) {
            if (this.hoverTerm === p.pane && this.hoverLink?.parent === p.terminal) return;
            this.hoverTerm = p.pane;
            this.hoverLink = { color: sshed ? this.linkColor(p.terminal) : null, visitor: sshed ? p.terminal : null, parent: p.terminal };
          } else {
            if (this.hoverTerm !== p.pane && this.hoverLink?.parent !== p.terminal) return;
            if (this.hoverTerm === p.pane) this.hoverTerm = null;
            if (this.hoverLink?.parent === p.terminal) this.hoverLink = null;
          }
          cx.notify();
        }))
        .on_click((e, cx) => {
          if (multi(e)) return this.pick(`p:${p.pane}`, cx, e);
          if (e.click_count === 2) return this.renamePane(p, a, tab);
          // Capture before any native focus command can acknowledge Done as
          // idle; shell rows have no agent and therefore never affect holds.
          if (a) this.applyOverviewAgentClick(a);
          const hadSelection = this.sel.size > 0;
          this.sel.clear();
          this.anchor = `p:${p.pane}`;
          run("pane.focus", { pane: p.pane });
          if (hadSelection) cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          this.rightClick(`p:${p.pane}`, () => openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 220, height: 330, props: { tab: "pane", target: { pane: p.pane, terminal: p.terminal }, view: "menu" } }));
        })
        // Keep the status indicator; plain terminals retain their shell icon.
        .child(h_flex().flex_none().gap(4).items_center()
          .child(h_flex().w(16).flex_none().justify_center()
            .when(Boolean(a), (el) => el.child(this.mark(a, t))))
          .when(!a, (el) => el.child(svg("icons/shell.svg").size(14).flex_none().text_color(t.foreground))))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().min_w(0).gap(6).items_center()
            .child(div().min_w(0).truncate().text_size(12.5).text_color(active || !idle ? t.foreground : t.muted)
              .when(Boolean(two), (el) => el.line_height("15px"))
              .child(a ? agentName(a, tab, p.cwd) : this.termName(p, tab, key)))
            .when(Boolean(ownership), (el) => el.child(ownership))
            // Its link and count chips: after its details (infoLine) on one line; on
            // two (expanded) or with no details, here on the name's line, at its end,
            // so the line under has the whole width.
            .when(!info || two, (el) => el.when(Boolean(two), (x) => x.child(div().flex_1())).children([this.endChips(a, p, t)].filter(Boolean))))
          .when(Boolean(two), (el) => el.overflow_hidden().child(info ? this.agentDetails(info, t, a, p, opt, false).line_height("13px")
            : h_flex().min_w(0).items_center().text_size(11).line_height("13px").text_color(t.dim)
              .children(dotted([div().text_color(t.muted).child(this.tagWhere?.folder ?? ""), this.tagWhere?.machine && div().child(this.tagWhere.machine)].filter(Boolean))))))
        .when(Boolean(info) && !two, (el) => el.child(this.agentDetails(info, t, a, p, opt)))
        .when(this.isLiveAgent(p.terminal), el => el.child(this.agentMenuButton(p.terminal, t)));
      // Its sub-agents nested under it (subRows), unless folded.
      return [row, ...(a && this.subsOpen.has(a.address) ? this.subRows(a, p, t, indent) : [])];
    })];
  }

  // Double-click: rename it, as the pane menu's Rename does (over9k-rename: an
  // agent's session by its own command, a plain terminal's tab).
  renamePane(p, a, tab) {
    const named = tab && !/^(\d+|tb?[0-9a-z]+)$/.test(tab.name) && tab.name !== (a ?? p)?.program?.name ? tab.name : "";
    openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 380, height: 200,
      props: { pane: p.pane, terminal: p.terminal, tab: tab?.id, alone: this.frame.ps.filter((x) => x.tab === p.tab).length === 1,
        value: named || (a ? agentTask(a, p.cwd) : ""), title: a ? `Rename ${a.program?.name ?? "agent"} session` : "Rename terminal", view: "rename" } });
  }

  // Under an agent, what it started: agents it ran in terminals of their own
  // (hc run: the core records the parent; they have no pane) with their
  // status, a click peeks at one; and Claude Code's own subagents (the Agent
  // tool, read from its transcript folder: subagents/*.meta.json), a spinner
  // while one works, then how long ago it finished, for 10 minutes. One working
  // in another space says which.
  // Goes to a pane: its space, its tab, then the pane (in order, through the CLI,
  // so a split that follows lands beside it).
  async goTo(pane) {
    const p = panes().find((x) => x.pane === pane);
    if (!p) return;
    const w = spaces().find((x) => (x.tabs ?? []).some((tb) => tb.id === p.tab));
    const go = (command, args) => exec("herdr-app", ["do", command, JSON.stringify(args)]).catch(() => null);
    if (w && !w.active) await go("space.select", { id: w.id });
    await go("tab.select", { id: p.tab });
    await go("pane.focus", { pane });
  }

  // Shows a terminal in the panel on the right (where Files and Changes open), in
  // the panel's stack (PANEL_VIEW, added to this layout the first time): a header
  // with its `title` and a close button (the over9k-panel mod), the terminal under
  // it. No tab, no pane, no row of its own. One at a time: a viewer this mod
  // started for the one before (`viewer`) ends. Clicked again while it shows: the
  // panel closes. A layout without that panel: a peek.
  showInPanel(terminal, viewer = false, title = "") {
    const was = shared("over9k.panelView");
    const panel = find(layout(), "panel");
    if (was?.terminal === terminal && panel && !panel.hidden && find(layout(), "panel-body")?.active === PANEL_VIEW) {
      run("layout.hide", { id: "panel" });
      run("layout.select", { stack: "panel-body", child: "files" });
      if (was.viewer) hc(["kill", terminal]).catch(() => null);
      return setShared("over9k.panelView", null);
    }
    // The layout's own file, not layout() (that's as drawn, without the nodes a
    // single child folds away, like the panel's own column): only the view's
    // terminal changes in it; showing and choosing stay clicks, so the Files and
    // Changes buttons still hide the panel.
    // Herdr's own layouts can't be changed this way: a peek there.
    const name = shared("layout") ?? "main";
    if (["main", "terminals", "win98"].includes(name)) return run("terminal.peek", { terminal });
    readTextFile(`${appHome()}/layouts/${name}.json`).then((text) => {
      let tree = null;
      try { tree = JSON.parse(text); } catch {}
      const stack = tree && find(tree, "panel-body");
      if (!stack) return run("terminal.peek", { terminal });
      const term = find(stack, `${PANEL_VIEW}-term`);
      if (term) term.content = { terminal };
      else stack.children = [...(stack.children ?? []), { id: PANEL_VIEW, type: "column", children: [
        { id: `${PANEL_VIEW}-head`, type: "block", size: { px: 30 }, content: { mod: "sidebar-overhaul", props: { view: "panel" } } },
        { id: `${PANEL_VIEW}-term`, type: "block", content: { terminal } },
      ] }];
      setShared("over9k.panelView", { terminal, viewer, title });
      run("layout.set", { layout: tree });
      run("layout.select", { stack: "panel-body", child: PANEL_VIEW });
      run("layout.show", { id: "panel" });
      if (was?.viewer && was.terminal !== terminal) hc(["kill", was.terminal]).catch(() => null);
    }).catch(() => run("terminal.peek", { terminal }));
  }

  // A click on a sub-row opens it; a press on its stop button doesn't.
  // `key`: its pick (Shift/Cmd/Ctrl+click picks it, as any row; a plain click
  // drops the picks).
  subClick(e, cx, key, open) {
    if (Date.now() - (this.btnAt ?? 0) < 400) return;
    if (multi(e)) return this.pick(key, cx, e);
    if (this.sel.size) { this.sel.clear(); cx.notify(); }
    this.anchor = key;
    this.showing = key; // the row whose view showSub puts up (it stays highlighted)
    if (e.click_count === 1) open();
  }

  // Shows what an agent started in place of the pane you're in, for now (Herdr's
  // terminal.show): nothing splits, nothing new is listed. Clicked again: back.
  // A viewer this mod started for the one before ends. Alt+click: in the side
  // panel instead (showInPanel).
  showSub(terminal, viewer = false, title = "", e = null) {
    if (e?.modifiers?.alt) return this.showInPanel(terminal, viewer, title);
    // Still up only while the focused pane shows it (clicked elsewhere: it isn't).
    const was = this.shownSub, up = was && [undefined, was.terminal].includes(focused()?.shown);
    if (up && was.terminal === terminal) {
      this.shownSub = null;
      run("terminal.show", {});
      if (was.viewer) hc(["kill", terminal]).catch(() => null);
      return;
    }
    this.shownSub = { terminal, viewer, key: this.showing };
    run("terminal.show", { terminal });
    if (was?.viewer) hc(["kill", was.terminal]).catch(() => null);
  }

  // Closes picked sub-rows (rightClick's "Close selected", through shared
  // "over9k.closeSubs"): a terminal ends; a Codex command's process ends; what only
  // its agent can stop (Claude's subagents, shells, monitors, scheduled prompts;
  // Codex's subagents) it's asked to, one message per agent.
  closeSubs(list) {
    const asks = {};
    for (const x of list) {
      if (x.kind === "terminal") run("terminal.kill", { terminal: x.terminal });
      else if (x.kind === "pid") exec("kill", [String(x.pid)]).catch(() => null);
      else (asks[x.agent] ??= []).push(x.text);
    }
    for (const [agent, items] of Object.entries(asks))
      hc(["send", agent, `Stop these of yours, then tell me in one line: ${items.join("; ")}.`]).catch(() => null);
  }

  // A live view in the panel (showInPanel): `script` (a file in this mod, sent
  // inline so nothing needs installing on the agent's computer) run with `args`
  // on `addr`'s computer. One per `key`: a second click shows the same one.
  view(key, addr, script, args, cx, title, e = null) {
    const [m] = addr.includes("/") ? addr.split("/") : [null];
    cx.spawn(async (cx) => {
      this.scripts ??= {};
      this.scripts[script] ??= await readTextFile(`${appHome()}/mods/sidebar-overhaul/${script}`).catch(() => null);
      if (!this.scripts[script]) return;
      this.viewers ??= {};
      const open = this.viewers[key];
      if (open && terminals().some((k) => k.address === open && k.state === "live")) return this.showSub(open, true, title, e);
      const r = await hc(["run", "--bg", "--json", "--label", "over9k=view", ...(m ? ["--on", m] : []), "--", "sh", "-c", this.scripts[script], "sh", ...args]).catch(() => null);
      let t = null;
      try { t = JSON.parse(r?.stdout ?? "").address; } catch {}
      if (!t) return;
      const at = m && !t.includes("/") ? `${m}/${t}` : t;
      // A moment for the window to know the new terminal, else the block is empty.
      await cx.sleep(500);
      this.viewers[key] = at;
      this.showSub(at, true, title, e);
    });
  }

  // A Claude subagent's transcript, live and readable (subagent-view.sh).
  viewSubagent(addr, id, cx, title, e = null) {
    const transcript = this.info[addr]?.transcript;
    if (!transcript) return;
    const file = `${transcript.replace(/\.jsonl$/, "")}/subagents/${id}.jsonl`;
    this.view(file, addr, "subagent-view.sh", [file], cx, title, e);
  }

  // Sub-agents (hc run, no pane of their own) working in space `w` while
  // their parent is somewhere else: listed here too, "from <parent>", with
  // their status; a click peeks at one. Only while they run. They also stay
  // under their parent (subRows).
  visitorRows(w, t, indent = 0) {
    const m = w.machine ?? null, folder = (w.folder ?? "").replace(/\/+$/, "");
    if (!folder) return [];
    const at = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
    // Without a pane, working here while what started it counts as elsewhere
    // (an agent of an agent working where that one does is listed under it).
    const here = (this.frame.terms ?? []).filter((k) => k.parent && k.state === "live" && k.cwd && at(k.address) === m
      && !this.isLiveAgent(k.address)
      && !this.frame.ps.some((p) => p.terminal === k.address) && this.workSpace(k.address)?.id === w.id && this.workSpace(k.parent)?.id !== w.id
      && !(this.isHiddenAgent(k.address) && (agentLike(k) || this.frame.ag.some((a) => a.address === k.address))));
    return here.map((k) => {
      const listed = this.frame.ag.find((x) => x.address === k.address);
      const terminalAgent = agentLike(k) ? {
        ...k,
        status: terminalAgentStatus(k) ?? "idle",
        seq: k.seq ?? k.report?.seq,
      } : null;
      const ka = listed ? this.presentationAgent(listed) : terminalAgent && this.presentationAgent(terminalAgent);
      const kind = ka ? "agent" : "process";
      const c = this.linkColor(k.address);
      // Hovered: its row under the agent that started it lights up.
      return lit(h_flex().id(`visit-${k.address}`), (this.hoverLink?.visitor === k.address || this.hoverLink?.parent === k.parent) && { color: c })
        .on_hover((h, cx) => { if (h) this.hoverLink = { color: c, source: k.address }; else if (this.hoverLink?.source === k.address) this.hoverLink = null; cx.notify(); })
        .h(26).flex_none().pl(4 + indent).pr(8).gap(8).items_center().rounded(7)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (e, cx) => {
          if (Date.now() - (this.btnAt ?? 0) < 400 || multi(e)) return this.subClick(e, cx, `k:${k.address}`, () => this.showSub(k.address, false, this.helperTitle(k.address) || k.name || (ka && agentTask(ka, k.cwd)) || appName(ka) || k.program?.name || k.agent, e));
          return this.subClick(e, cx, `k:${k.address}`, () => this.showSub(k.address, false, this.helperTitle(k.address) || k.name || (ka && agentTask(ka, k.cwd)) || appName(ka) || k.program?.name || k.agent, e));
        })
        .child(h_flex().flex_none().gap(4).items_center()
          .child(h_flex().w(16).flex_none().justify_center().when(Boolean(ka), (el) => el.child(this.mark(ka, t))))
          .when(kind === "process", el => el.child(svg(CPU).size(14).flex_none().text_color(t.foreground))))
        .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().line_height("15px").text_size(12.5).text_color(t.muted).child(this.helperTitle(k.address) || k.name || (ka && agentTask(ka, k.cwd)) || appName(ka) || k.program?.name || k.address)))
        .child(linkChip(t, `visit-chip-${k.address}`, { dir: "in", icon: kind === "process" ? CPU : BOT, color: c }));
    });
  }

  // What an agent has going besides terminals: a Claude Code session's
  // background shells and monitors, or a Codex agent's running commands (procs);
  // Claude's scheduled prompts and wakeups (crons): tasks.sh; a Codex agent's
  // own subagents (csubs): codex.sh.
  bgTasks(a) {
    const all = this.tasks?.[a.address] ?? [];
    const of = (...kinds) => all.filter((x) => kinds.includes(x.kind));
    return { procs: of("shell", "monitor", "cshell"), crons: of("cron", "wakeup"), csubs: of("csub") };
  }

  // Claude's subagents still going: a finished (or stopped) one leaves the list
  // at once. A quiet one is waiting (on its own background work, a long command)
  // and stays; only one silent for a day goes (its session died without saying).
  liveSubs(a) {
    return (this.subs?.[a.address] ?? []).filter((x) => !x.done && Date.now() / 1000 - x.at < 86400);
  }

  // What an agent has started, for the chip's icons: agents it ran in a terminal
  // of their own (Herdr's), subagents (inner: Claude's, Codex's), processes and
  // scheduled prompts, its agents' included.
  subCounts(a) {
    const kids = (this.frame.terms ?? []).filter((k) => k.parent === a.address && k.state === "live");
    const agents = kids.filter((k) => this.frame.ag.some((x) => x.address === k.address) || k.program?.agent || isAgentProgram(k.agent)).length;
    const bg = this.bgTasks(a);
    const n = { inner: this.liveSubs(a).length + bg.csubs.length, agents, processes: kids.length - agents + bg.procs.length, crons: bg.crons.length };
    // And what its agents started, and theirs (all under its one chip).
    for (const k of kids) {
      if (!(this.frame.ag.some((x) => x.address === k.address) || k.program?.agent || isAgentProgram(k.agent))) continue;
      const m = this.subCounts(this.frame.ag.find((x) => x.address === k.address) ?? k);
      for (const key of Object.keys(n)) n[key] += m[key];
    }
    return n;
  }

  // One colour per agent that started something: the faint background of all it
  // started (subagents and processes, wherever they're listed) matches.
  // A link's colour (by the terminal at its near end, or "terminal|subagent"):
  // the first of LINK_COLORS no other live link has, kept while it lives (a
  // subagent's while its ssh does, so finished ones free theirs). All taken: the
  // least used.
  linkColor(address) {
    this.linkColors ??= {};
    if (!this.linkColors[address]) {
      const live = new Set((this.frame.terms ?? []).filter((k) => k.state === "live").map((k) => k.address));
      for (const k of Object.keys(this.linkColors))
        if (!live.has(k.split("|")[0]) || (k.includes("|") && !this.subSsh?.[k])) delete this.linkColors[k];
      const n = (c) => Object.values(this.linkColors).filter((x) => x === c).length;
      this.linkColors[address] = LINK_COLORS.reduce((a, c) => (n(c) < n(a) ? c : a));
    }
    return this.linkColors[address];
  }


  // The place a terminal counts as being in: its pane's space, else (something
  // an agent started) the most specific folder on its computer holding its own:
  // an open space's, or a pinned project's that has none (Not open: { id, folder,
  // machine, project }, its row then lifted into the list, lifted()).
  workSpace(address) {
    const p = this.frame.ps.find((x) => x.terminal === address);
    if (p) return this.frame.sp.find((s) => (s.tabs ?? []).some((tb) => tb.id === p.tab)) ?? null;
    const k = (this.frame.terms ?? []).find((x) => x.address === address);
    const m = address.includes("/") ? address.split("/")[0] : null, cwd = (k?.cwd ?? "").replace(/\/+$/, "");
    if (!cwd) return null;
    const open = this.frame.sp.filter((s) => (s.machine ?? null) === m && s.folder && inside(cwd, s.folder.replace(/\/+$/, "")));
    const closed = this.closedOn(m).filter((d) => inside(cwd, d)).map((d) => ({ id: m ? `r:${m}:${d}` : `c:${d}`, folder: d, machine: m, project: true }));
    return [...open, ...closed].sort((a, b) => b.folder.replace(/\/+$/, "").length - a.folder.replace(/\/+$/, "").length)[0] ?? null;
  }

  // Pinned projects with no open space, here (closedProjects) or on computer `m`
  // (its list, listedOn), once a render (this.frame.closed).
  closedOn(m) {
    return ((this.frame.closed ??= {})[m ?? ""] ??= m
      ? this.listedOn(m).filter((d) => !this.frame.sp.some((s) => s.machine === m && inside((s.folder ?? "").replace(/\/+$/, ""), d))
        && !this.frame.groups.has(folderGroupKey(m, d)))
      : this.closedProjects(this.frame.ps));
  }

  // Those of them something an agent started works in now (elsewhere than that
  // agent): listed with the spaces while it does, what works there under it.
  lifted(m) {
    const live = (this.frame.terms ?? []).filter((k) => k.parent && k.state === "live" && (k.address.includes("/") ? k.address.split("/")[0] : null) === m
      && !this.frame.ps.some((p) => p.terminal === k.address));
    // On another computer, also one an agent here (or its subagent) is ssh'd into.
    const home = m && this.remote[m]?.home;
    const full = (d) => (home ? d.replace(/^~(?=\/|$)/, home) : d);
    const sshed = !m ? [] : [
      ...Object.values(this.sshTo ?? {}).filter((e) => e.self && e.to === m && e.at === this.sshSeen),
      ...Object.entries(this.subSsh ?? {}).filter(([k, v]) => v.to === m && this.subs?.[k.split("|")[0]]?.some((x) => x.id === k.split("|")[1] && !x.done)).map(([, v]) => v),
    ].flatMap((e) => (e.paths ?? []).map(full));
    return this.closedOn(m).filter((d) => {
      const id = m ? `r:${m}:${d}` : `c:${d}`;
      return live.some((k) => this.workSpace(k.address)?.id === id && this.workSpace(k.parent)?.id !== id) || sshed.some((x) => inside(x, d));
    });
  }

  // A helper (hc run) goes by its `task` label, what the agent that started it wrote
  // (hc run --label task=...). Without one, an Antigravity helper goes by the title
  // agy gave it, since its --name is a short handle for hc commands, not something to
  // read: agy-info.py's title, else the terminal's (its database doesn't always have
  // one), but not agy's placeholder.
  helperTitle(address) {
    const k = (this.frame.terms ?? []).find((x) => x.address === address);
    if (k?.labels?.task) return k.labels.task;
    const i = this.info[address];
    if (i?.agent !== "antigravity") return null;
    const live = k && agentTask(k, k.cwd);
    return sentenceCase(i.title || (live === APP_NAMES.antigravity ? "" : live));
  }

  // A terminal by the name its row shows: an agent's (agentName), a plain
  // terminal's (termName), else what it was started as.
  nameOf(address) {
    const p = this.frame.ps.find((x) => x.terminal === address), a = this.frame.ag.find((x) => x.address === address);
    if (p) { const tab = this.frame.sp.flatMap((s) => s.tabs ?? []).find((tb) => tb.id === p.tab); return a ? agentName(a, tab, p.cwd) : this.termName(p, tab, ""); }
    const k = (this.frame.terms ?? []).find((x) => x.address === address);
    return this.helperTitle(address) || k?.name || (k && this.frame.ag.some((x) => x.address === address) && agentTask(k, k.cwd)) || appName(k) || address;
  }

  // Where a terminal is ssh'd to (findSsh), while it is: the computer's name.
  // `who`: "self" only its own (not its subagents'), a subagent's id only that
  // one's (in the last minute).
  sshedTo(address, who = null) {
    if (who && who !== "self") return this.subSsh?.[`${address}|${who}`]?.to ?? null;
    const e = this.sshTo?.[address];
    return e && e.at === this.sshSeen && (!who || e.self) ? e.to : null;
  }

  subCount(a) {
    const n = this.subCounts(a);
    return n.agents + n.inner + n.processes + n.crons;
  }

  // `nest`: how far in, for an agent's agents (one under another's row); `indent`
  // is the space's (a worktree's rows go in further). `rails`: where lines of
  // the agents above go on down past these rows (to their next item).
  subRows(a, p, t, indent, nest = 0, rails = []) {
    const kids = (this.frame.terms ?? []).filter((k) => k.parent === a.address && k.state === "live");
    const inner = this.liveSubs(a);
    const bg = this.bgTasks(a);
    const isAgent = (k) => Boolean(this.frame.liveAgentByAddress?.has(k.address) || this.frame.ag.some((x) => x.address === k.address) || k.program?.agent || isAgentProgram(k.agent));
    // Agents, then subagents (Claude's, Codex's), then processes, then scheduled
    // prompts and wakeups (as on the chip).
    const items = [
      ...kids.filter((k) => isAgent(k) && !this.isLiveAgent(k.address) && !this.isHiddenAgent(k.address)).map((k) => ({ type: "kid", k })),
      ...inner.map((x) => ({ type: "sub", x })),
      ...bg.csubs.map((x) => ({ type: "csub", x })),
      ...kids.filter((k) => !isAgent(k)).map((k) => ({ type: "kid", k })),
      ...[...bg.procs, ...bg.crons].map((x) => ({ type: "task", x })),
    ];
    if (!items.length) return [];
    // Its line's middle, from the row's left: under the agent's icon (status 12, a gap, half the line's 12).
    const x0 = indent + nest + 10 + 12 + 3 + 6;
    // One line each: its status (spinner, stop: under the agent's own), its line
    // with what it is on it, then the rest. Picked (Shift/Cmd/Ctrl+click), it
    // shows so, and closes with the other picks (rightClick, closeSubs).
    // `hover`: more to do on hovering it (a row with a link chip lights its other end).
    const row = (id, key, pick, hover = null, right = null) => {
      this.vis.push(key);
      this.subPicks.set(key, pick);
      return rails.reduce((el, x) => el.child(div().absolute().left(x - 0.75).top(0).bottom(0).w(1.5).bg(t.input)), h_flex().id(id).relative())
        .h(22).flex_none().pl(indent + nest + 10).pr(8).gap(3).items_center().rounded(7).text_size(12)
        .hover((s) => s.bg(t.hover))
        .when(this.sel.has(key), (el) => el.bg(t.accent + "38"))
        // Shown in place now (showSub): highlighted, as a focused row is.
        .when(!this.sel.has(key) && this.shownSub?.key === key && terminals().some((k) => k.address === this.shownSub.terminal && k.state === "live")
          && this.frame.focus?.shown === this.shownSub.terminal, (el) => el.bg(t.hover))
        .on_hover((h, cx) => { if (h) this.hoverSub = id; else if (this.hoverSub === id) this.hoverSub = null; hover?.(h); cx.notify(); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (this.sel.has(key) && this.sel.size > 1) this.rightClick(key, () => {}); else right?.(cx); });
    };
    const now = Date.now() / 1000;
    // How long it has run.
    const ranFor = (sec) => div().child(span(sec));
    // Context used, coloured as on an agent's row (infoLine).
    const ctx = (pct) => { pct = Math.round(pct ?? 0); return div().text_color(pct >= 80 ? t.ansi1 : pct >= 50 ? t.ansi3 : t.ansi2).child(`${pct}%`); };
    this.kidSeen ??= {}; // when a started terminal was first seen (if Herdr gives no created_ms)
    // Its name, then what goes beside it (details, → space).
    const body = (name, side = []) => h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).child(name.min_w(0).truncate().line_height("15px"))).children(side);
    // Its details beside its name, dimmed, dotted (as an agent's: infoLine).
    const facts = (...parts) => h_flex().flex_none().items_center().text_size(11).text_color(t.dim)
      .children(dotted(parts.filter(Boolean).map((x) => (typeof x === "string" ? div().child(x) : x))));
    // A small button shown while the row is hovered.
    // Its press is marked so the row under it doesn't also open (subClick).
    const btn = (id, icon, fn) => h_flex().id(id).flex_none().w(12).h(12).justify_center().items_center().rounded(4).cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { this.btnAt = Date.now(); cx.stop_propagation(); })
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(svg(icon).size(8));
    // Its status slot: hovered, a stop button; else a spinner while it works.
    // A pixel lower than the middle, in line with the text and logo.
    const status = (id, stop, working) => h_flex().w(12).pt(2).flex_none().justify_center()
      .when(this.hoverSub === id, (el) => el.child(btn(`stop-${id}`, "mods/sidebar-overhaul/stop.svg", stop)))
      .when(this.hoverSub !== id && Boolean(working), (el) => el.child(working));
    const spinner = () => svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(900);
    // The line down from the agent above (under its icon's middle, as a
    // worktree's), with what each one is on it, small, the line broken around it:
    // BOT (an agent), SUB (a subagent), CPU (a process) or CLOCK (a scheduled
    // prompt or wakeup), as on the count chip. The last one's line ends at it.
    const lead = (icon, last) => v_flex().w(12).h(22).flex_none().items_center()
      .child(div().w(1.5).h(icon === SUB ? 5 : 6).flex_none().bg(t.input))
      .child(svg(icon).size(icon === SUB ? 12 : 9).flex_none().my(1).text_color(t.dim))
      .child(div().w(1.5).flex_1().when(!last, (el) => el.bg(t.input)));
    const pname = this.nameOf(a.address);
    // Its agent, for what has no view of its own (a scheduled prompt, a Codex
    // subagent or command): its pane, or, with none (an agent's agent), shown in place.
    const toAgent = (e) => this.frame.ps.some((x) => x.terminal === a.address) ? this.goTo(p.pane) : this.showSub(a.address, false, pname, e);
    // Asking the agent that started it (Claude's and Codex's own take orders only from it).
    const ask = (text) => hc(["send", a.address, text]).catch(() => null);

    const kidRow = (k, last) => {
      // An agent in it: Herdr's agents list has it when it has a pane; else its terminal says.
      const listed = this.frame.ag.find((x) => x.address === k.address);
      const terminalAgent = isAgent(k) ? {
        ...k,
        status: terminalAgentStatus(k) ?? "idle",
        seq: k.seq ?? k.report?.seq,
      } : null;
      const ka = listed ? this.presentationAgent(listed) : terminalAgent && this.presentationAgent(terminalAgent);
      const kind = ka ? "agent" : "process";
      const name = this.helperTitle(k.address) || k.name || (ka && agentTask(ka, k.cwd)) || appName(ka) || k.program?.name || k.address;
      // The space it works in, only when that isn't where the agent that started it
      // is (workSpace): then a chip goes there.
      const home = this.workSpace(k.address);
      const where = home && home.id !== this.workSpace(a.address)?.id ? home : null;
      // Or on another computer (over ssh): the same link, to there (sshRows).
      const sshed = this.sshedTo(k.address);
      const c = (where || sshed) && this.linkColor(k.address);
      // An agent's details as on any agent row: model, context, time.
      const codex = ka && isCodex(ka) ? codexTitle(ka.title) : null;
      const raw = ka && (codex ? (codex.model ? codex : null) : isPi(ka) ? this.piInfo[ka.address] : this.info[ka.address]);
      const info = raw && this.withModel(raw, ka);
      // Herdr's start time when it gives one, else when first seen here.
      const ran = ranFor(now - (k.created_ms ? k.created_ms / 1000 : (this.kidSeen[k.address] ??= now)));
      const id = `kid-${k.address}`, key = `k:${k.address}`;
      // Hovered, with a chip: its row in that space lights up.
      const hover = where || sshed ? (h) => { if (h) this.hoverLink = { color: c, visitor: k.address }; else if (this.hoverLink?.visitor === k.address) this.hoverLink = null; } : null;
      const right = kind === "agent" && !this.frame.ps.some((x) => x.terminal === k.address)
        ? (cx) => openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 220, height: 120, props: { tab: "agent", target: { terminal: k.address }, view: "menu" } })
        : null;
      return lit(row(id, key, { kind: "terminal", terminal: k.address }, hover, right), (this.hoverLink?.source === k.address || (c && this.hoverLink?.parent === a.address)) && { color: c })
        .on_mouse_down("left", (e, cx) => {
          if (Date.now() - (this.btnAt ?? 0) < 400 || multi(e)) return this.subClick(e, cx, key, () => this.showSub(k.address, false, this.helperTitle(k.address) || k.name || (ka && agentTask(ka, k.cwd)) || appName(ka) || k.program?.name || k.agent, e));
          return this.subClick(e, cx, key, () => this.showSub(k.address, false, this.helperTitle(k.address) || k.name || (ka && agentTask(ka, k.cwd)) || appName(ka) || k.program?.name || k.agent, e));
        })
        .child(status(id, () => closeAsk({ terminals: [k.address] }), ka && this.mark(ka, t, 10)))
        .child(body(div().text_color(t.muted).child(name), [
          facts(info?.model && modelName(info.model), info && ctx(info.context), ran),
          // "→ space" (a click goes to that space).
          (where || sshed) && linkChip(t, `kid-chip-${k.address}`, { dir: "out", icon: kind === "process" ? CPU : BOT, color: c, to: !where && sshed }),
        ].filter(Boolean)));
    };

    // A Claude subagent: what it's doing, "waiting" once it's been quiet a minute
    // (on its own background work), its type, tokens used and how long it has run.
    // A click: its live transcript (viewSubagent).
    const subRow = (x, last) => {
      const id = `sub-${a.address}-${x.id}`, key = `x:${a.address}|sub|${x.id}`;
      const stop = `Stop your subagent "${x.desc}" (agent id ${x.id.replace(/^agent-/, "")}) with TaskStop, then tell me in one line.`;
      // SSH'd to another computer (findSsh): a chip saying where, linked like the agent's.
      const link = `${a.address}|${x.id}`, sshed = this.sshedTo(a.address, x.id), c = sshed && this.linkColor(link), o = this.frame.options;
      const hover = sshed ? (h) => { if (h) this.hoverLink = { color: c, visitor: link }; else if (this.hoverLink?.visitor === link) this.hoverLink = null; } : null;
      return lit(row(id, key, { kind: "ask", agent: a.address, text: `subagent "${x.desc}" (agent id ${x.id.replace(/^agent-/, "")}): TaskStop` }, hover), (this.hoverLink?.source === link || (sshed && this.hoverLink?.parent === a.address)) && { color: c })
        .on_mouse_down("left", (e, cx) => this.subClick(e, cx, key, () => this.viewSubagent(a.address, x.id, cx, x.desc || "Subagent", e)))
        .child(status(id, () => ask(stop), spinner()))
        .child(lead(SUB, last))
        .child(body(div().text_color(t.muted).child(x.desc || "Subagent"),
          [facts(now - x.at > 60 && "waiting", o.subModel && x.model && modelName(x.model), o.subEffort && effortName(x.effort),
            x.type && x.type.toLowerCase() !== "general-purpose" && x.type.toLowerCase(), o.subContext && x.tokens > 0 && tokensK(x.tokens), o.subTime && x.start && ranFor(now - x.start)),
            sshed && linkChip(t, `sub-chip-${a.address}-${x.id}`, { dir: "out", icon: SUB, color: c, to: sshed })].filter(Boolean)));
    };

    // A Codex agent's own subagent (codex.sh): its nickname and task, its role and
    // how long it has run. Codex shows it (its agents list), so a click goes there.
    const csubRow = (x, last) => {
      const id = `csub-${a.address}-${x.id}`, key = `x:${a.address}|csub|${x.id}`;
      return row(id, key, { kind: "ask", agent: a.address, text: `subagent "${x.desc}": close it` })
        .on_mouse_down("left", (e, cx) => this.subClick(e, cx, key, () => toAgent(e)))
        .child(status(id, () => ask(`Close your subagent "${x.desc}", then tell me in one line.`), spinner()))
        .child(lead(SUB, last))
        .child(body(div().text_color(t.muted).child(x.desc || "Subagent"), [facts(x.schedule !== "subagent" && x.schedule, x.start && ranFor(now - x.start))]));
    };

    // A Claude Code session's background shell, monitor, scheduled prompt or
    // wakeup, or a Codex agent's running command. Stop: Claude's own take orders
    // only from their session, so it's asked; a Codex command is a process here,
    // so it's ended. A click: a shell's or monitor's output, live; anything else,
    // its agent (where it runs, or where Codex's /ps shows it).
    const taskRow = (x, last) => {
      const id = `task-${a.address}-${x.id}`, key = `x:${a.address}|${x.kind}|${x.id}`;
      const cron = x.kind === "cron" || x.kind === "wakeup";
      const order = x.kind === "cron" ? `scheduled prompt ${x.id}: CronDelete`
        : x.kind === "wakeup" ? "scheduled wakeup: ScheduleWakeup with stop: true"
        : `background ${x.kind} "${x.desc}" (task id ${x.id}): TaskStop`;
      const stop = x.kind === "cshell" ? () => exec("kill", [x.id]).catch(() => null) : () => ask(`Stop your ${order}, then tell me in one line.`);
      // Beside its name: a scheduled prompt's schedule, a wakeup's time to go, a
      // command's kind and how long it has run.
      const what = x.kind === "cron" ? facts(short(x.schedule ?? "").replace(/^./, (ch) => ch.toLowerCase()))
        : x.kind === "wakeup" ? facts("wakeup", span(Math.max(0, +x.schedule - now)))
        : facts(x.kind === "cshell" ? "command" : x.kind, x.start && ranFor(now - x.start));
      return row(id, key, x.kind === "cshell" ? { kind: "pid", pid: x.id } : { kind: "ask", agent: a.address, text: order })
        .on_mouse_down("left", (e, cx) => this.subClick(e, cx, key, () => x.output ? this.view(x.output, a.address, "output-view.sh", [x.output, x.desc], cx, x.desc, e)
          // A scheduled prompt or wakeup: itself, in place (note-view.sh): when, whose, what.
          : cron ? this.view(`note-${x.kind}-${x.id}`, a.address, "note-view.sh", [
            x.kind === "wakeup" ? "Wakeup" : "Scheduled prompt",
            x.kind === "wakeup" ? `In ${span(Math.max(0, +x.schedule - Date.now() / 1000))}` : short(x.schedule ?? ""),
            `For ${pname}`, "", x.kind === "wakeup" ? `Why: ${x.desc}` : x.desc], cx, x.desc, e)
          : toAgent(e)))
        .child(status(id, stop, null))
        .child(lead(cron ? CLOCK : CPU, last))
        .child(body(div().text_color(t.muted).child(x.desc || (cron ? "Scheduled prompt" : "Background command")), [what]));
    };

    return items.flatMap((it, i) => {
      const last = i === items.length - 1;
      if (it.type === "sub") return [subRow(it.x, last)];
      if (it.type === "csub") return [csubRow(it.x, last)];
      if (it.type === "task") return [taskRow(it.x, last)];
      // An agent it started: what that one started under it, one step in (its line
      // under that agent's icon), this line going on past them unless it was the
      // last. Always shown: the top agent's chip folds the lot and counts it all.
      const kidEls = [kidRow(it.k, last)];
      if (!isAgent(it.k)) return kidEls;
      const ka = this.frame.ag.find((x) => x.address === it.k.address) ?? it.k;
      return [...kidEls, ...this.subRows(ka, this.frame.ps.find((x) => x.terminal === it.k.address) ?? p, t, indent, nest + 16, last ? rails : [...rails, x0])];
    });
  }


  // A plain terminal's name: its tab's when someone renamed it, else the last
  // command run in it (readCommands), else "New CLI". An agent that hasn't
  // reported yet (Codex's update prompt) already goes by its agent name.
  termName(p, tab, key) {
    if (p.program?.agent) return agentName(p, tab, p.cwd);
    if (!/^(\d+|t[0-9a-z]+)$/.test(tab.name) && tab.name !== p.program?.name) return tab.name;
    // Started straight on an ssh (no prompt to read): that command (findSsh).
    const command = this.lastCmd[p.terminal] ?? this.titleCommand(p.title, p.program?.name ?? "") ?? this.sshTo?.[p.terminal]?.cmd;
    if (command) return command.length > 48 ? `${command.slice(0, 47)}\u2026` : command;
    return "New CLI";
  }

  // Each shell's screen (here or on a connected computer), for its last prompt line. Only what changed is shared.
  readCommands(cx) {
    if (this.reading || !this.frame) return;
    // Here, and on other computers that are connected (read over Herdr's link).
    const up = new Set(this.machines.filter((m) => m.state === "connected").map((m) => m.name));
    const reachable = new Set(this.frame.sp.filter((s) => !s.machine || up.has(s.machine)).flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
    const shells = this.frame.ps.filter((p) => p.terminal && reachable.has(p.tab) && !this.frame.byPane.get(p.pane));
    if (!shells.length) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      let changed = false;
      for (const p of shells) {
        const r = await hc(["read", p.terminal, "--lines", "200"]).catch(() => null);
        const lines = (r?.stdout ?? "").split("\n").map((l) => /^\s*\u276f\s+(\S.*?)\s*$/.exec(l)?.[1]).filter(Boolean);
        const last = lines[lines.length - 1];
        if (last && last !== this.lastCmd[p.terminal]) { this.lastCmd[p.terminal] = last; changed = true; }
      }
      const live = new Set(this.frame.ps.map((p) => p.terminal));
      for (const t of Object.keys(this.lastCmd)) if (!live.has(t)) { delete this.lastCmd[t]; changed = true; }
      if (changed) setShared("terminals.last", { ...this.lastCmd });
      this.reading = false;
      if (changed) cx.notify();
    });
  }

  // Every terminal of the space picked one by one: closing them closes it too.
  allPicked(w) {
    if (!this.sel.size) return false;
    const tabs = new Set((w.tabs ?? []).map((x) => x.id));
    const mine = this.frame.ps.filter((p) => p.terminal && tabs.has(p.tab));
    return mine.length > 0 && mine.every((p) => this.sel.has(`p:${p.pane}`));
  }

  // The command a shell's title names, if any: Pure's "folder: cmd - prog" while
  // it runs; "folder - fish" names none; any other title is taken as the command.
  titleCommand(title, shell) {
    title = (title ?? "").trim();
    const running = /^[^:]*: (.+) [-\u2014\u2013] \S+$/.exec(title);
    if (running) return running[1].trim();
    if (!title || title === shell || title.endsWith(` ${shell}`)) return null;
    // "user@host:~/folder", as many shells title themselves (another computer's): names nothing.
    if (/^[^@\s]+@[^:\s]+:\S*$/.test(title)) return null;
    return title;
  }

  hasTerms(key) {
    return Boolean(this.frame.groups.get(key)?.length);
  }

  // Shift+click picks every row from the last one clicked to this one (in the
  // order they're shown); Cmd/Meta or Ctrl+click adds or drops one row.
  pick(key, cx, e) {
    const order = this.visible ?? [];
    const from = order.indexOf(this.anchor), to = order.indexOf(key);
    if (e?.modifiers?.shift && from >= 0 && to >= 0) {
      if (!(e.modifiers.platform || e.modifiers.control)) this.sel.clear();
      // Terminal to terminal takes only the terminals between (not the spaces
      // they pass, which would close whole spaces); space to space only spaces.
      const term = (k) => /^[pkx]:/.test(k);
      const same = term(this.anchor) === term(key);
      order.slice(Math.min(from, to), Math.max(from, to) + 1).filter((k) => !same || term(k) === term(key)).forEach((k) => this.sel.add(k));
    } else {
      this.sel.has(key) ? this.sel.delete(key) : this.sel.add(key);
      this.anchor = key;
    }
    cx.notify();
  }

  // Right-click on a picked row: one menu for all the picks (over9k-menu's
  // "selection": close them, unpin the spaces among them). On any other row,
  // the picks go and that row's own menu opens, as on a row that's the only pick.
  rightClick(key, own) {
    if (!this.sel.has(key) || this.sel.size === 1) { this.sel.clear(); return own(); }
    const picked = { spaces: [], panes: [], folders: [] };
    const listed = new Set(this.projects), trim = (d) => (d ?? "").replace(/\/+$/, "");
    for (const k of this.sel) {
      const v = k.slice(2);
      if (k.startsWith("s:")) {
        picked.spaces.push(v);
        const f = trim(this.frame.sp.find((s) => s.id === v)?.folder);
        if (listed.has(f)) picked.folders.push(f);
      } else if (k.startsWith("p:")) picked.panes.push(v);
      else if (k.startsWith("d:") || k.startsWith("r:")) {
        picked.panes.push(...(this.frame.groups.get(k) ?? []).map((x) => x.p.pane));
        if (k.startsWith("d:") && listed.has(v)) picked.folders.push(v);
      } else if (this.subPicks.has(k)) (picked.subs ??= []).push(this.subPicks.get(k));
    }
    // The picks stay shown while the menu is open (and after Esc); closed or
    // unpinned rows drop out of them by themselves.
    openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 240, height: 120, props: { tab: "selection", target: picked, view: "menu" } });
  }

  // A spinner while working, a dot when done (or waiting on you); nothing when idle.
  // `size`: the spinner's (a sub-row's is smaller).
  mark(a, t, size = 12) {
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(size).text_color(t.working).spin(900);
    if (a.status === "blocked") return div().size(7).rounded(4).bg(t.blocked);
    if (a.status === "done") return div().size(7).rounded(4).bg(t.done ?? t.accent);
    return div();
  }

  // Folders set up for an agent (MARKED), but not home, /tmp, or a folder that
  // only holds projects (~/Code). The menu reads them (shared) to offer Hide or Pin.
  scanProjects(cx) {
    cx.spawn(async cx => {
      try {
        const config = await sidebarConfig();
        const set = localScanSettings(config);
        const full = (d) => d.replace(/^~(?=\/|$)/, homeDir());
        const where = { chats: full(set.chats || "~"), projects: full(set.projects || "~") };
        this.scannedWith = JSON.stringify(set);
        const code = [where.projects];
        if (JSON.stringify(where) !== JSON.stringify(shared("over9k.locations"))) setShared("over9k.locations", where);
        if (JSON.stringify(code) !== JSON.stringify(shared("projects.codeFolders"))) setShared("projects.codeFolders", code);
        if (!set.keepUpToDate && shared("over9k.setupDone")) return;
        const r = await exec("sh", ["-c", MARKED, "sh", ...code]);
        if (r.code !== 0) return;
        const root = where.projects.replace(/\/+$/, "") || "/";
        const all = r.stdout.split("\n").filter(Boolean).map((d) => d.replace(/\/+$/, "")).filter(d => root === "/" || d.startsWith(root + "/"));
        const dirs = all.filter((d) => d !== homeDir() && !inside(d, "/tmp") && !SKIP.has(base(d)) && !all.some((o) => o !== d && inside(o, d)));
        if (JSON.stringify(dirs) !== JSON.stringify(this.auto)) {
          this.auto = dirs;
          setShared("projects.auto", dirs);
          cx.notify();
        }
        this.firstRun();
        this.autoPin(dirs);
      } catch {}
    });
  }

  // The same on other computers, run there over SSH: their Projects (set, or the
  // first usual folder there) and the projects in it. Kept (localStorage) and
  // looked for again only when a computer connects again or its folders change;
  // never while it's away. `only`: just these computers.
  scanRemote(cx, only = null) {
    const config = currentSidebarConfig();
    const settings = m => ({
      chats: machineLocation(config, m, "chats", "~"),
      projects: machineLocation(config, m, "projects", null),
      keepUpToDate: lookupMachineOption(config, m, "keepUpToDate", shared("sidebar.options")?.keepUpToDate),
    });
    const up = this.machines.filter(m => m.name && m.state === "connected").map(m => m.name)
      .filter(m => only ? only.includes(m) : JSON.stringify(settings(m)) !== JSON.stringify(this.remote[m]?.asked));
    if (!up.length) return;
    cx.spawn(async (cx) => {
      const found = {};
      for (const m of up) {
        try {
          const own = settings(m);
          const named = own.projects ? null : (await exec("sh", ["-c", PROJECTS_FROM_RULES], { on: m }).catch(() => null))?.stdout.trim();
          const where = { chats: own.chats, projects: own.projects ?? (named || "~") };
          const home = (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: m }))?.stdout?.trim() ?? "";
          const root = where.projects.replace(/^~(?=\/|$)/, home).replace(/\/+$/, "") || "/";
          const r = own.keepUpToDate && (home || !/^~(?=\/|$)/.test(where.projects)) ? await exec("sh", ["-c", MARKED, "sh", root], { on: m }) : null;
          const all = (r?.code === 0 ? r.stdout : "").split("\n").filter(Boolean).map(d => d.replace(/\/+$/, "")).filter(d => root === "/" || d.startsWith(root + "/"));
          const dirs = all.filter(d => d !== home && d !== root && !inside(d, "/tmp") && !SKIP.has(base(d)) && !all.some(o => o !== d && inside(o, d)));
          found[m] = { ...where, home, dirs, asked: own };
          this.autoPin(dirs, m);
        } catch {}
      }
      const all = { ...this.remote, ...found };
      const autoOn = Object.fromEntries(Object.entries(all).map(([m, f]) => [m, f.dirs ?? []]));
      if (JSON.stringify(autoOn) !== JSON.stringify(shared("projects.autoOn") ?? {})) setShared("projects.autoOn", autoOn);
      const shown = Object.fromEntries(Object.entries(all).map(([m, f]) => [m, { chats: f.chats, projects: f.projects }]));
      if (JSON.stringify(shown) !== JSON.stringify(shared("over9k.remoteLocations") ?? {})) setShared("over9k.remoteLocations", shown);
      if (JSON.stringify(all) !== JSON.stringify(this.remote)) {
        this.remote = all;
        localStorage.setItem("remote.projects", JSON.stringify(all));
        cx.notify();
      }
    });
  }

  // The project list: marked folders unless hidden, and pinned ones, by name.
  // Another computer's list, as listed() is this one's: what was found there
  // (kept from its last scan) less what's unpinned, plus what's pinned.
  listedOn(m) {
    const entries = (currentSidebarConfig() ?? this.config)?.machines?.[m]?.projects?.pinned ?? shared("projects.on")?.[m]?.pinned ?? [];
    return [...new Set(entries.map((entry) => typeof entry === "string" ? entry : entry.path ?? entry.repo).filter(Boolean))].sort((a, b) => base(a).localeCompare(base(b), undefined, { sensitivity: "base" }));
  }

  // The list is what's pinned in the source-owned config.
  listed() {
    const entries = (currentSidebarConfig() ?? this.config)?.machines?.local?.projects?.pinned ?? shared("projects.pinned") ?? [];
    return [...new Set(entries.map((entry) => typeof entry === "string" ? entry : entry.path ?? entry.repo).filter(Boolean))].sort((a, b) => base(a).localeCompare(base(b), undefined, { sensitivity: "base" }));
  }

  // "Keep sidebar up to date" (over9k-options): what a scan found that's new
  // (not pinned, and not unpinned by hand) gets pinned. m: another computer.
  autoPin(found, m = null) {
    const config = currentSidebarConfig() ?? this.config;
    if (!lookupMachineOption(config, m, "keepUpToDate", shared("sidebar.options")?.keepUpToDate)) return;
    const on = config?.machines?.[m ?? "local"]?.projects;
    if (!on) return;
    const pinned = new Set((on.pinned ?? []).map((entry) => typeof entry === "string" ? entry : entry.path ?? entry.repo));
    const off = new Set([...(on.unpinned ?? []), ...(on.hidden ?? [])].map((entry) => typeof entry === "string" ? entry : entry.path ?? entry.repo));
    const add = found.filter((d) => !pinned.has(d) && !off.has(d));
    if (!add.length) return;
    const next = [...(on.pinned ?? []), ...add];
    if (m) {
      setShared("projects.on", { ...(shared("projects.on") ?? {}), [m]: { ...on, pinned: next } });
      updateSidebarConfig((config) => { config.machines[m].projects.pinned = next; return config; }).then((result) => { this.config = result.config; }).catch(() => null);
    } else {
      setShared("projects.pinned", next);
      updateSidebarConfig((config) => { config.machines.local.projects.pinned = next; return config; }).then((result) => { this.config = result.config; }).catch(() => null);
    }
  }

  // Pins folders (as over9k-menu's Pin: not hidden, not unpinned any more).
  pinHanded(dirs, m = null) {
    const all = shared("projects.on") ?? {}, on = m ? all[m] ?? {} : null;
    const pinned = new Set(m ? on.pinned ?? [] : shared("projects.pinned") ?? []);
    const hidden = new Set(m ? on.hidden ?? [] : shared("projects.hidden") ?? []);
    const unpinned = new Set(m ? on.unpinned ?? [] : shared("projects.unpinned") ?? []);
    for (const d of dirs) { pinned.add(d); hidden.delete(d); unpinned.delete(d); }
    if (m) return setShared("projects.on", { ...all, [m]: { ...on, pinned: [...pinned], hidden: [...hidden], unpinned: [...unpinned] } });
    setShared("projects.pinned", [...pinned]);
    setShared("projects.hidden", [...hidden]);
    setShared("projects.unpinned", [...unpinned]);
  }

  // The first time this version runs: everything the list showed before
  // (found less unpinned, plus pinned, on every computer) becomes pinned, so
  // nothing goes; then Options opens in setup mode (over9k-options).
  firstRun() {
    if (shared("over9k.setupDone")) return;
    const hidden = new Set(shared("projects.hidden") ?? []);
    setShared("projects.pinned", [...new Set([...(shared("projects.pinned") ?? []), ...this.auto.filter((d) => !hidden.has(d))])]);
    const on = { ...(shared("projects.on") ?? {}) };
    for (const [m, f] of Object.entries(this.remote ?? {})) {
      const h = new Set(on[m]?.hidden ?? []);
      on[m] = { ...(on[m] ?? {}), pinned: [...new Set([...(on[m]?.pinned ?? []), ...(f.dirs ?? []).filter((d) => !h.has(d))])] };
    }
    setShared("projects.on", on);
    setShared("over9k.setupDone", true);
    openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 560, height: 600, props: { setup: true, view: "options" } });
  }

  // Terminals' folders whose repo top isn't known yet: looked up one by one.
  resolveTops(cx) {
    const want = [...(this.wantTops ?? [])].filter((c) => !this.tops.has(c));
    if (!want.length || this.resolving) return;
    this.resolving = true;
    cx.spawn(async (cx) => {
      for (const c of want) {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: c }).catch(() => null);
        this.tops.set(c, r?.code === 0 ? r.stdout.trim() : c);
      }
      this.resolving = false;
      cx.notify();
    });
  }

  // Projects with no space on this computer made in them.
  spaceless(sp) {
    const local = sp.filter((s) => !s.machine);
    return this.projects.filter((d) => !local.some((s) => inside(s.folder, d)));
  }

  // Folders with no space but a terminal in them now (it cd'd there), with those
  // terminals under them: a listed project in its color after the spaces, any
  // other folder in plain white right after ~ (right-click to pin it). Remote
  // folders use machine-qualified keys and keep the same native menu payload.
  looseRows(t, collapsed, projects, m = null, matching = false) {
    const listed = new Set(m ? this.listedOn(m) : this.projects);
    const groups = m
      ? (this.remoteLoose ?? []).filter((group) => group.machine === m)
      : (this.loose ?? []).map((folder) => ({ key: folderGroupKey(null, folder), folder, machine: null }));
    const visibleAgents = (key) => this.liveAgentsInGroup(key).filter((entry) => !this.isHiddenAgent(entry.address));
    return groups.filter(({ folder }) => m || listed.has(folder) === projects)
      .filter(({ key }) => {
        const visible = visibleAgents(key).length;
        return (!this.isHiddenGroup(key) || visible > 0) && (!matching || this.spaceMatches(key) || visible > 0);
      }).flatMap(({ key, folder: dir }) => {
        const project = Boolean(m) || listed.has(dir);
        const name = this.alias(dir, m);
        const g = m ? null : this.git[JSON.stringify([null, dir])] ?? null;
        this.vis.push(key);
        const folded = this.agentsFolded.has(key);
        const row = h_flex().id(m ? `loose-${m}-${name}` : `loose-${name}`).h(collapsed ? 26 : 30).flex_none().px(collapsed ? 0 : 8).gap(9).items_center().rounded(8)
          .when(collapsed, (el) => el.justify_center())
          .hover((s) => s.bg(t.hover))
          .when(this.sel.has(key), (el) => el.bg(t.accent + "38"))
          .on_hover((on, cx) => { if (on) this.hoverSpace = key; else if (this.hoverSpace === key) this.hoverSpace = null; cx.notify(); })
          .on_mouse_down("right", () => this.rightClick(key, () => this.folderMenu(dir, m, key)))
          .on_click((e, cx) => {
            if (multi(e)) return this.pick(key, cx, e);
            this.sel.clear();
            this.anchor = key;
            folded ? this.agentsFolded.delete(key) : this.agentsFolded.add(key);
            localStorage.setItem("agents.folded", JSON.stringify([...this.agentsFolded]));
            cx.notify();
          })
          .when(collapsed, (el) => el.text_color(project ? MARK[hue(name)] : t.foreground).child([...name][0]?.toUpperCase() ?? "?"))
          .when(!collapsed, (el) => el
            .child(div().flex_shrink(0).max_w(150).truncate().text_color(project ? MARK[hue(name)] : t.foreground).child(name))
            .when(Boolean(g?.web) && this.frame.options.github, (el) => el.child(this.ghLink(g, t)))
            .when(Boolean(g), (el) => el.children(this.counts(g, t, (cx) => this.showChanges({ name, folder: dir }, cx))))
            .child(h_flex().w(FOLD).flex_none().items_center().justify_center()
              .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(10).text_color(t.dim).opacity(this.hoverSpace === key ? 1 : 0)))
            .child(this.tail(g, null, name, t, this.hoverSpace === key && dir))
            .child(this.plusButton(m ? `loose-add-${m}-${name}` : `loose-add-${name}`, this.hoverSpace === key, t, () => this.openProject(dir, m))));
        return [row, ...(collapsed || (folded && !this.liveAgentsInGroup(key).length) ? [] : this.termRows(key, t))];
      });
  }

  // Projects with no space on this computer made there or with a terminal in it now.
  // `ps`: panes(), read once by the caller.
  closedProjects(ps) {
    const local = this.frame.sp.filter(s => !s.machine);
    const tabs = new Set(local.flatMap(s => (s.tabs ?? []).map(t => t.id)));
    const cwds = ps.filter(p => tabs.has(p.tab)).map(p => p.cwd);
    return this.projects.filter(d => !local.some(s => inside(s.folder, d)) && !cwds.some(c => inside(c, d)));
  }

  // A project's name: the one given with Rename (projects.names), else its folder's.
  // A space's name: another computer's home is "~" there too (Herdr would call
  // it after the folder), and its renamed projects go by their names.
  title(w) {
    if (!w.machine || w.named) return title(w);
    const r = this.remote[w.machine], f = (w.folder ?? "").replace(/\/+$/, "");
    if (r?.home && (f === r.home || !f)) return "~";
    return shared("projects.on")?.[w.machine]?.names?.[f] || w.name;
  }

  alias(dir, m = null) {
    const names = m ? shared("projects.on")?.[m]?.names : this.frame.names;
    return (names ?? {})[dir] || base(dir) || dir;
  }

  // A + that shows while the pointer is on its row.
  plusButton(id, shown, t, fn) {
    const slot = h_flex().w(ADD).flex_none().justify_center();
    if (!shown) return slot;
    return slot.child(h_flex().id(id).size(18).items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); fn(); })
      .child(svg("mods/workspace-chrome/plus.svg").size(12)));
  }

  // The + menu for a space not open yet: what's picked there opens it.
  openProject(dir, m = null) {
    openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 340, height: 640, props: { folder: dir, name: this.alias(dir, m), ...(m ? { machine: m } : {}), view: "new-menu" } });
  }

  // A space not open: a click picks it (Shift/Cmd too, to unpin several), a
  // double-click opens it with OMP; its +
  // (on hover) opens the + menu, where what's picked opens it.
  // On another computer (m): no git counts or menu (both are this computer's);
  // opening makes its space there.
  closedRow(dir, t, collapsed, m = null) {
    const name = this.alias(dir, m);
    const key = m ? `r:${m}:${dir}` : `c:${dir}`;
    if (!m) this.vis.push(key);
    return h_flex().id(`project-${name}`).h(collapsed ? 26 : 30).flex_none().px(collapsed ? 0 : 8).gap(9).items_center().rounded(8)
      .when(collapsed, el => el.justify_center())
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .when(this.sel.has(key), (el) => el.bg(t.accent + "38"))
      .on_hover((on, cx) => { if (on) this.hoverSpace = key; else if (this.hoverSpace === key) this.hoverSpace = null; cx.notify(); })
      .on_click((e, cx) => {
        if (multi(e) && !m) return this.pick(key, cx, e);
        // Twice: open it with OMP.
        if (e.click_count === 2) {
          // Its space, made once: a second double-click shows the one there.
          this.sel.clear();
          const there = spaces().find((s) => (s.machine ?? null) === m && (s.folder ?? "").replace(/\/+$/, "") === dir);
          return there ? run("space.select", { id: there.id }) : run("space.new", { name, folder: dir, machine: m ?? "", argv: ["bash", "-lc", "exec omp"] });
        }
        this.sel = new Set([key]);
        this.anchor = key;
        cx.notify();
      })
        .on_mouse_down("right", () => (m ? this.folderMenu(dir, m, `r:${m}:${dir}`) : this.rightClick(`c:${dir}`, () => this.folderMenu(dir, null, `d:${dir}`))))
      .when(collapsed, el => el.child([...name][0]?.toUpperCase() ?? "?"))
      .when(!collapsed, el => (g => el
        .child(div().flex_shrink(0).max_w(150).truncate().child(name))
        .when(Boolean(g?.web) && this.frame.options.github, el => el.child(this.ghLink(g, t)))
        .when(Boolean(g), el => el.children(this.counts(g, t, (cx) => this.showChanges({ name, folder: dir }, cx))))
        .child(this.tail(g, null, name, t, this.hoverSpace === key && dir))
        .child(this.plusButton(`open-${m ?? ""}-${name}`, this.hoverSpace === key, t, () => this.openProject(dir, m)))
        )(this.git[JSON.stringify([m, dir])]));
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "--untracked-files=all"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, dirty: 0, web: null, slug: null, top: top.stdout.trim(), repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line && !line.startsWith("#")) info.dirty++;
        else if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      // A GitHub remote (origin first) becomes a link to the repo's page.
      const urls = (await exec("git", ["remote", "-v"], { cwd, on })).stdout.split("\n")
        .map((l) => l.split(/\s+/)).filter(([n, , kind]) => kind === "(fetch)").sort(([a], [b]) => (b === "origin") - (a === "origin"));
      for (const [, url] of urls) {
        const m = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? "");
        if (m) { info.web = `https://github.com/${m[1]}`; info.slug = m[1]; break; }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // Right-click on a row with no space: open it, pin it, or hide this displayed project group.
  folderMenu(folder, m = null, key = null) {
    const group = this.groupTarget(key ?? (m ? `r:${m}:${folder}` : `d:${folder}`), "project", this.alias(folder, m), m, folder);
    openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 220, height: 225,
      props: { tab: "project", target: { folder, name: this.alias(folder, m), group, ...(m ? { machine: m } : {}) }, view: "menu" } });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    const group = this.groupTarget(w.id, "space", this.title(w), w.machine, w.folder);
    openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 230, height: 325,
      props: { tab: "space", target: { id: w.id, group }, view: "menu" } });
  }


  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const { sp, ps } = this.frame;
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─", under: r.w.id }));
    }
    return out;
  }

  // Whether an agent (a pane's, or none) shows in the current view.
  passes(a) {
    if (this.section) return a?.status === this.section;
    return this.viewMode !== "status" || Boolean(a);
  }

  // A space with a visible agent the current view lets through.
  spaceMatches(id) {
    return groupHasPassingPane(this.frame.groups.get(id), this.frame.byPane, (a) => Boolean(a)
      && !this.isHiddenAgent(a.address) && this.passes(a));
  }

  viewToggle(t) {
    const current = this.statusView() ? "Status" : "Space";
    const next = current === "Status" ? "Space" : "Status";
    return h_flex().id("view-toggle").h(20).px(7).flex_none().items_center().rounded(5).cursor_pointer()
      .text_color(t.foreground).bg(t.raised).hover((s) => s.bg(t.hover))
      .tooltip(`Switch to ${next} view`)
      .on_click((_e, cx) => { this.restoreView(next.toLowerCase()); cx.notify(); })
      .child(current);
  }

  viewBar(t, hiddenSnapshot = null) {
    const hiddenRows = hiddenSnapshot?.rows ?? this.hiddenRows();
    const hiddenGroups = hiddenSnapshot?.groups ?? this.hiddenGroups(hiddenRows);
    const hidden = hiddenRows.length + hiddenGroups.length;
    return h_flex().id("view-bar").flex_none().h(30).px(8).gap(2).items_center().text_size(11.5)
      .child(this.viewToggle(t))
      .when(hidden > 0, (el) => el.child(div().flex_1()).child(h_flex().id("show-hidden").h(20).px(7).gap(4).flex_none().items_center().rounded(5).cursor_pointer()
        .text_color(this.visibilityState().open ? t.foreground : t.muted).when(this.visibilityState().open, (x) => x.bg(t.raised))
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.toggleHidden(cx))
        .child(this.visibilityState().open ? "Hide hidden" : "Show hidden").child(div().text_color(t.dim).child(String(hidden)))));
  }

  // A space's colour as its row draws it (null: home, or not a listed project).
  // A folder as you'd type it: ~ for home, here or on another computer (its home kept from its scan).
  where(folder, m = null) {
    const d = (folder ?? "").replace(/\/+$/, ""), h = m ? this.remote[m]?.home : homeDir();
    return h && (d === h || d.startsWith(h + "/")) ? `~${d.slice(h.length)}` : d || "~";
  }

  spaceColor(w, t) {
    const color = this.frame.colors[w.id];
    return !color || this.title(w) === "~" ? null : color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  }

  // Status view by state, as Herdr's Priority view: Needs you, Done, Working,
  // Idle (only those with any), each with how many; in each, every computer's
  // agents together, most recently changed first, each naming its space (and
  // the computer when that's another) and with what it started. A computer that
  // isn't connected: its agents faded, as last seen.
  agentSections(t, rows) {
    const off = (m) => Boolean(m) && !this.machines.some((x) => x.name === m && x.state === "connected");
    const out = [];
    for (const sec of SECTIONS) {
      const list = (this.frame.liveAgents ?? []).filter((entry) => !this.isHiddenAgent(entry.address) && this.presentationAgent(entry.display)?.status === sec.status)
        .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
      if (!list.length) continue;
      const foldKey = `status:${sec.status}`;
      const folded = this.agentsFolded.has(foldKey);
      out.push(h_flex().id(`section-${sec.status}`).h(26).mt(out.length ? 8 : 2).px(8).gap(6).flex_none().items_center().text_size(11.5).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleSectionFold(foldKey, cx))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(div().size(6).rounded(3).flex_none().bg(t[sec.status] ?? t.dim)).child(sec.label).child(div().text_color(t.dim).child(String(list.length))));
      for (const entry of list) {
        const group = entry.visualGroup ?? {};
        const folder = group.folder ? this.where(group.folder, entry.machine) : "~";
        this.tagWhere = { color: null, folder, machine: entry.machine };
        const row = this.liveAgentRow(entry, t, 0);
        this.tagWhere = null;
        out.push(off(entry.machine) ? v_flex().flex_none().opacity(0.4).child(row) : row);
      }
    }
    return out;
  }

  // The rows, under a heading per computer: This computer always, then each other one.
  grouped(t, collapsed) {
    // This computer's rows: ~, then spaces in folders that aren't projects (white),
    // then projects, each group in Herdr's order.
    const listed = new Set(this.projects);
    const rank = (r) => r.w.machine ? 0 : (r.w.folder ?? "").replace(/\/+$/, "") === homeDir() ? 0 : r.tree || listed.has((r.w.folder ?? "").replace(/\/+$/, "")) ? 2 : 1;
    const rows = this.drawn = orderBlocks(this.ordered(), rank);
    if (this.statusView() && !collapsed) return this.agentSections(t, rows);
    // A status view folds to agent-containing spaces; Space keeps every row.
    const on = this.statusView();
    const draw = (r) => {
      const liveInGroup = this.liveAgentsInGroup(r.w.id);
      const visibleInGroup = liveInGroup.filter((entry) => !this.isHiddenAgent(entry.address));
      if (liveInGroup.length && !this.groupHasVisibleContent(r.w.id)) return [];
      if (on && !this.spaceMatches(r.w.id) && !visibleInGroup.length) return [];
      if (r.under && this.agentsFolded.has(r.under) && !visibleInGroup.length) return [];
      return [this.row(r, t), ...(this.agentsFolded.has(r.w.id) ? this.liveAgentRowsForGroup(r.w.id, t, r.tree ? TREE : 0) : this.termRows(r.w.id, t, r.tree ? TREE : 0)),
        ...(r.w.machine && r.w.folder && !on ? this.sshRows(r.w.machine, t, r.w.folder.replace(/\/+$/, "")) : []),
        ...(this.agentsFolded.has(r.w.id) || on ? [] : this.visitorRows(r.w, t, r.tree ? TREE : 0))];
    };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = this.frame.ms.find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || this.frame.sp.some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    // Built top to bottom (functions, called in order) so this.vis, which Shift+click
    // ranges follow, is in the order shown.
    // Not open projects something works in now, lifted into the list (lifted).
    const busy = (m) => on || collapsed ? [] : this.lifted(m).flatMap((d) => {
      const key = m ? `r:${m}:${d}` : `d:${d}`;
      if (this.isHiddenGroup(key)) return [];
      const workspaceId = m ? `r:${m}:${d}` : `c:${d}`;
      return [this.closedRow(d, t, collapsed, m),
        ...this.visitorRows({ id: workspaceId, machine: m, folder: d }, t), ...(m ? this.sshRows(m, t, d) : [])];
    });
    const closed = () => on ? [] : [...busy(null), ...this.looseRows(t, collapsed, true), ...this.closedSection(t, collapsed)];
    // Other folders' rows go right after ~ (first, when there's no ~ space).
    const others = () => on ? [] : this.looseRows(t, collapsed, false);
    const atHome = (r) => !r.w.machine && (r.w.folder ?? "").replace(/\/+$/, "") === homeDir();
    const homeAt = rows.findIndex(atHome);
    const drawAll = (list) => list.flatMap((r) => [...draw(r), ...(r === rows[homeAt] ? others() : [])]);
    // This computer always gets its heading (its +, local servers), others too.
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      // The heading keeps the arrow (it folds on a click); its + gets the hand.
      const head = h_flex().id(`machine-${m ?? "local"}`).h(31).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11.5).text_color(t.dim)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 260, height: 90, props: { tab: "machine", target: { machine: m }, view: "menu" } });
        })
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(14).flex_none())
        // Name, then whether it's reachable and the fold chevron right after it; the + at the far end.
        .when(!collapsed, el => el.child(div().min_w(0).truncate().child(m ?? "This computer"))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none())
          .when(!m, el => el.children(this.serverChips(t)))
          .child(div().flex_1())
          .when(connected, el => el.child(h_flex().id(`machine-add-${m ?? "local"}`).size(18).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.addHome(m); })
            .child(svg("mods/workspace-chrome/plus.svg").size(12)))));
      const liveMachine = (this.frame.liveAgents ?? []).filter((entry) => (entry.machine ?? null) === m);
      const canonical = liveMachine.filter((entry) => !entry.pane && !rows.some((row) => row.w.id === entry.visualGroup?.key));
      const drawn = m ? [...(on ? [] : this.sshRows(m, t)), ...mine.flatMap(draw), ...this.looseRows(t, collapsed, null, m, on), ...busy(m), ...canonical.map((entry) => this.liveAgentRow(entry, t))] : [...(homeAt < 0 ? others() : []), ...drawAll(mine), ...canonical.map((entry) => this.liveAgentRow(entry, t))];
      const extra = on ? [] : m ? this.closedSection(t, collapsed, m) : closed();
      // Status view: a computer with nothing that passes isn't listed at all.
      if (on && !drawn.length) return [];
      // Nothing under a machine with no spaces: its heading's + makes one.
      // Not connected: what's there is as last seen, faded (nothing in it is live).
      const shown = connected ? [...drawn, ...extra] : [v_flex().flex_none().opacity(0.4).children([...drawn, ...extra])];
      return [head, ...(folded && !liveMachine.length ? [] : mine.length || extra.length || drawn.length ? shown : loading(m) ? [loadingRow(m)] : [])];
    });
  }

  // A row's right side: while hovered, its folder (a button's hover text wins);
  // otherwise nothing.
  tail(g, tree, name, t, path) {
    const tip = g && this.tip?.repo === g.repo ? this.tip.text : null;
    const text = tip ?? (path ? tilde(path) : "");
    return h_flex().flex_1().min_w(0).justify_end().items_center().text_size(11).text_color(t.dim)
      .when(Boolean(text), (el) => el.child(div().min_w(0).truncate().child(text)));
  }

  // Next to the name (after its GitHub icon), each a button: uncommitted files
  // (shows Changes), commits not pushed (push, on a second click), commits to
  // pull (pull, fast-forward only), open pull requests, open issues and stars
  // (each opens its page on GitHub; issues and stars only on a repo you can
  // push to, not one you only cloned). Each kind only when over9k-options shows
  // it (dirty, sync, prs, issues, stars).
  counts(g, t, show) {
    const out = [], o = this.frame.options;
    if (o.dirty && g.dirty > 0) out.push(this.action(div().id(`dirty-${g.repo}`).text_color(t.ansi3), g, t,
      `See ${plural(g.dirty, "uncommitted file")}`, show).child(String(g.dirty)));
    if (o.sync && g.ahead > 0) {
      const can = this.canPush(g);
      const armed = this.armed?.repo === g.repo;
      out.push(this.action(div().id(`ahead-${g.repo}`).text_color(t.ansi2).when(armed, (el) => el.bg(t.hover)), g, t,
        armed ? "Click again to push" : can ? `Push ${plural(g.ahead, "commit")}` : this.write[g.slug] === false ? `${plural(g.ahead, "commit")} not pushed (not your repo)` : `${plural(g.ahead, "commit")} not pushed (shared main: use a PR)`,
        can ? (cx) => this.push(g, cx) : null).child(`\u2191${g.ahead}`));
    }
    if (o.sync && g.behind > 0) out.push(this.action(div().id(`behind-${g.repo}`).text_color(t.ansi1), g, t,
      `Pull ${plural(g.behind, "new commit")}`, (cx) => this.gitOp(g, ["pull", "--ff-only", "--quiet"], `Pulled ${g.name}`, cx))
      .child(`\u2193${g.behind}`));
    const pr = g.slug && this.prs[g.slug];
    if (o.prs && pr?.open) out.push(this.action(h_flex().id(`pr-${g.repo}`).gap(2).items_center().text_color(pr.review ? t.blocked : t.dim), g, t,
      pr.review ? `${plural(pr.open, "pull request")}, ${pr.review} needs your review` : `Open ${plural(pr.open, "pull request")}`,
      (cx) => cx.open_url(`${g.web}/pulls`)).child(svg("mods/sidebar-overhaul/pull-request.svg").size(11)).child(String(pr.open)));
    const info = g.slug && this.write[g.slug] && this.repoInfo[g.slug];
    if (o.issues && info?.issues) out.push(this.action(h_flex().id(`issues-${g.repo}`).gap(2).items_center().text_color(t.dim), g, t,
      `Open ${plural(info.issues, "issue")}`, (cx) => cx.open_url(`${g.web}/issues`))
      .child(svg("mods/sidebar-overhaul/issue.svg").size(11)).child(String(info.issues)));
    if (o.stars && info?.stars) out.push(this.action(h_flex().id(`stars-${g.repo}`).gap(2).items_center().text_color(t.dim), g, t,
      `${plural(info.stars, "star")} on GitHub`, (cx) => cx.open_url(`${g.web}/stargazers`))
      .child(svg("mods/sidebar-overhaul/star.svg").size(11)).child(String(info.stars)));
    return out.length ? [h_flex().flex_none().gap(3).items_center().text_size(11.5).children(out)] : [];
  }

  // A number you can click: `text` says what the click does while the pointer is on it.
  action(el, g, t, text, fn) {
    el = this.explained(el.px(2).rounded(4), g, text);
    if (!fn) return el;
    return el.cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); });
  }

  // A repo you can push to: your own, or your team's off its main branch (a shared
  // repo's main takes PRs).
  canPush(g) {
    if (g.slug && this.write[g.slug] === false) return false;
    const owner = g.slug?.split("/")[0];
    return Boolean(this.me && owner === this.me) || !["main", "master"].includes(g.branch);
  }

  push(g, cx) {
    if (!(this.armed?.repo === g.repo && Date.now() < this.armed.until)) {
      this.armed = { repo: g.repo, until: Date.now() + 4000 };
      this.tip = { repo: g.repo, text: "Click again to push" };
      cx.timer.after(4000, (cx) => { if (this.armed?.repo === g.repo) { this.armed = null; cx.notify(); } });
      cx.notify();
      return;
    }
    this.armed = null;
    this.gitOp(g, ["push", "--quiet"], `Pushed ${g.name}`, cx);
  }

  // Runs git in the repo, says how it went, and looks at the repo again.
  gitOp(g, args, done, cx) {
    this.tip = { repo: g.repo, text: args[0] === "push" ? "Pushing\u2026" : "Pulling\u2026" };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("env", [...QUIET, "git", ...args], { cwd: g.top, on: JSON.parse(g.repo)[0] ?? undefined });
      const why = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).pop() ?? "";
      notify(r.code === 0 ? { title: done, level: "success" } : { title: `Couldn't ${args[0]} ${g.name}`, body: why, level: "error" });
      if (this.tip?.repo === g.repo) this.tip = null;
      this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === g.repo), cx);
      cx.notify();
    });
  }

  // The project's space in front (made if it isn't open), with the Changes panel showing.
  // The panel waits until the space is in front: the tab bar restores each space's
  // own panel when it switches, which would hide one shown before.
  showChanges(target, cx) {
    const there = () => spaces().find((s) => s.active && (target.id ? s.id === target.id : !s.machine && s.folder.replace(/\/+$/, "") === target.folder));
    const show = () => { run("layout.select", { stack: "panel-body", child: "changes" }); run("layout.show", { id: "panel" }); };
    if (there()) return show();
    if (target.id) run("space.select", { id: target.id });
    else run("space.new", { machine: "", ...target, argv: ["bash", "-lc", "exec omp"] });
    let tries = 0;
    const wait = (cx) => cx.timer.after(50, (cx) => (there() ? cx.timer.after(150, () => show()) : ++tries < 60 && wait(cx)));
    wait(cx);
  }

  // Each GitHub repo in the list, one after another: fetch, then count its open
  // PRs, open issues and stars.
  refreshRemote(cx) {
    if (this.remoteBusy) return;
    this.remoteBusy = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.me) this.me = (await exec("gh", ["api", "user", "--jq", ".login"])).stdout.trim() || null;
        const seen = new Set();
        for (const [k, g] of Object.entries(this.git)) {
          if (!g?.slug || seen.has(g.repo)) continue;
          seen.add(g.repo);
          // Fetched where the repo is (another computer's over SSH); its PRs come from GitHub.
          const on = JSON.parse(k)[0];
          if (on && !this.machines.some((x) => x.name === on && x.state === "connected")) continue;
          await exec("env", [...QUIET, "git", "fetch", "--quiet"], { cwd: g.top, on: on ?? undefined });
          const v = await exec("gh", ["repo", "view", g.slug, "--json", "viewerPermission,stargazerCount,issues",
            "--jq", "[.viewerPermission, .stargazerCount, .issues.totalCount] | @tsv"]);
          if (v.code === 0) {
            const [perm, stars, issues] = v.stdout.trim().split("\t");
            this.write[g.slug] = ["ADMIN", "MAINTAIN", "WRITE"].includes(perm);
            this.repoInfo[g.slug] = { stars: Number(stars) || 0, issues: Number(issues) || 0 };
          }
          const r = await exec("gh", ["pr", "list", "--repo", g.slug, "--state", "open", "--limit", "100", "--json", "number,reviewRequests,author"]);
          if (r.code === 0) {
            // Someone else's project you only cloned: just the PRs that involve you.
            const list = JSON.parse(r.stdout).filter((p) => this.write[g.slug] !== false || p.author?.login === this.me
              || (p.reviewRequests ?? []).some((q) => q.login === this.me));
            this.prs[g.slug] = { open: list.length, review: list.filter((p) => (p.reviewRequests ?? []).some((q) => q.login === this.me)).length };
          }
          this.refreshGit(Object.keys(this.git).filter((x) => this.git[x]?.repo === g.repo), cx);
        }
      } catch {}
      this.remoteBusy = false;
      cx.notify();
    });
  }

  // While the pointer is on `el`, `text` says what it is, in the row's free
  // space on the right (tail). Herdr's own tooltips don't show in this list.
  explained(el, g, text) {
    return el.on_hover((on, cx) => {
      if (on) this.tip = { repo: g.repo, text };
      else if (this.tip?.text === text) this.tip = null;
      cx.notify();
    });
  }

  // The agents in the order they were last focused (shared "over9k.recentAgents",
  // for over9k-switcher); gone ones drop off.
  trackRecent() {
    const all = agents(), now = all.find((a) => a.focused)?.address;
    const live = new Set(all.map((a) => a.address));
    const next = [...(now ? [now] : []), ...this.recent.filter((x) => x !== now && live.has(x))];
    if (JSON.stringify(next) === JSON.stringify(this.recent)) return;
    this.recent = next;
    setShared("over9k.recentAgents", next);
  }

  row({ w, i, g, tree }, t) {
    this.vis.push(`s:${w.id}`);
    const color = this.frame.colors[w.id];
    // Home (here or on another computer) stays uncoloured.
    const fill = !color || this.title(w) === "~" ? t.foreground : color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const setup = this.frame.failedSetups?.get(JSON.stringify([w.machine ?? null, normalizeRoot(w.folder)]));
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .hover((s) => s.bg(t.hover))
      .when(this.sel.has(`s:${w.id}`) || this.allPicked(w), (el) => el.bg(t.accent + "38"))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i && multi(_e)) this.pick(`s:${w.id}`, cx, _e);
        else if (from === i) { this.sel.clear(); this.anchor = `s:${w.id}`; this.clickSpace(w); }
        cx.notify();
      })
      .on_mouse_down("right", () => this.rightClick(`s:${w.id}`, () => this.menu(w)))
      .on_hover((on, cx) => {
        if (on) this.hoverSpace = w.id;
        else if (this.hoverSpace === w.id) this.hoverSpace = null;
        cx.notify();
      })
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(16).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(fill).child(this.title(w)))
          .when(Boolean(g?.web) && !tree && this.frame.options.github, el => el.child(this.ghLink(g, t)))
          .when(Boolean(setup), el => el.child(div().id(`worktree-setup-${w.id}`).flex_none().cursor_pointer().text_size(11).text_color(t.blocked)
            .tooltip("Open setup terminal")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              cx.stop_propagation();
              const pane = this.frame.ps.find(p => p.terminal === setup.address);
              if (pane) {
                if (!w.active) run("space.select", { id: w.id });
                run("pane.focus", { pane: pane.pane });
              } else run("terminal.show", { terminal: setup.address });
            }).child("Setup failed")))
          .when(Boolean(g), el => el.children(this.counts(g, t, (cx) => this.showChanges({ id: w.id }, cx))))
          .child(this.agentFold(w, t))
          .child(this.tail(g, tree, w.name, t, this.hoverSpace === w.id && w.folder))
          .child(this.addSlot(w, t)),
      );
  }

  // Right after the name, when the repo is on GitHub: its icon, which opens the repo.
  ghLink(g, t) {
    if (!g?.web) return null;
    return this.explained(div().id(`web-${g.web}`).flex_none().ml(-5).p(2).rounded(4).cursor_pointer().text_color(t.dim), g,
      "Open in GitHub")
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(g.web); })
      .child(svg("mods/sidebar-overhaul/github.svg").size(13));
  }

  // "+", while the pointer is on the row: the new-tab menu (a terminal or any
  // installed agent) for this space; over9k-new-menu is the tab bar's menu
  // without "New space".
  addSlot(w, t) {
    const slot = h_flex().w(ADD).flex_none().justify_center();
    if (this.hoverSpace !== w.id) return slot;
    return slot.child(h_flex().id(`add-${w.id}`).size(18).items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        if (!w.active) run("space.select", { id: w.id });
        cx.stop_propagation();
        openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 340, height: 640,
          props: { space: w.id, folder: w.folder, machine: w.machine ?? null, view: "new-menu" } });
      })
      .child(svg("mods/workspace-chrome/plus.svg").size(12)));
  }

  // A chevron, only while the pointer is on a row with terminals, says whether
  // they're folded. Clicking the row folds them.
  agentFold(w, t) {
    if (!this.hasTerms(w.id)) return div().w(FOLD).flex_none();
    const folded = this.agentsFolded.has(w.id);
    return h_flex().w(FOLD).flex_none().items_center().justify_center().text_size(11).text_color(t.dim)
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(10).opacity(this.hoverSpace === w.id ? 1 : 0));
  }

  // A click on the shown space folds or shows its agents; on another space it
  // shows that space, with its agents.
  clickSpace(w) {
    const folded = this.agentsFolded.has(w.id);
    if (!w.active) {
      run("space.select", { id: w.id });
      if (!folded) return;
      this.agentsFolded.delete(w.id);
    } else if (!this.hasTerms(w.id)) return;
    else folded ? this.agentsFolded.delete(w.id) : this.agentsFolded.add(w.id);
    localStorage.setItem("agents.folded", JSON.stringify([...this.agentsFolded]));
  }

  // A computer's +: the new-tab menu (a terminal or an agent) in its home space,
  // so nothing new lands outside a project or ~. With none yet, the menu makes it
  // with what's picked there (nothing starts on its own).
  addHome(m) {
    const { there, made } = this.homeSpace(m);
    if (there && !there.active) run("space.select", { id: there.id });
    openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 340, height: 640, props: { computer: true, ...made, ...(m ? { machine: m } : {}), view: "new-menu" } });
  }

  // A computer's home space (there), or what making it takes (made).
  homeSpace(m) {
    // This computer's chats start in its Chats folder (over9k-options; home unless set).
    // Another computer's in its own (over9k-options; its home unless set).
    const r = m && this.remote[m];
    const home = m ? r?.home : homeDir();
    const location = machineLocation(currentSidebarConfig(), m, "chats", r?.chats ?? "~");
    const chats = /^~(?=\/|$)/.test(location) ? (home ? location.replace(/^~/, home) : location === "~" ? null : location) : location;
    const there = spaces().find((s) => (s.machine ?? null) === m && (m && !chats ? s.name === "~" : (s.folder ?? "").replace(/\/+$/, "") === chats));
    return { there, made: there ? {} : { folder: chats ?? undefined, name: !chats || chats === home ? "~" : base(chats) } };
  }

  // Projects with no space, under one header, folded until opened.
  // On another computer (m): its listed projects with no space open.
  closedSection(t, collapsed, m = null) {
    const busy = new Set(this.lifted(m));
    const list = this.closedOn(m).filter((d) => !busy.has(d) && !this.isHiddenGroup(m ? `r:${m}:${d}` : `d:${d}`));
    if (!list.length) return [];
    const open = m ? Boolean(this.closedOpenOn[m]) : this.closedOpen;
    const head = h_flex().id(`projects-closed-${m ?? "local"}`).h(26).flex_none().mt(6).px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
      .rounded(7).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (m) {
          this.closedOpenOn[m] = !open;
          localStorage.setItem("projects.closedOpenOn", JSON.stringify(this.closedOpenOn));
        } else {
          this.closedOpen = !this.closedOpen;
          localStorage.setItem("projects.closedOpen", String(this.closedOpen));
        }
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .when(!collapsed, (el) => el.child(div().flex_1().truncate().child("Parked")));
    return [head, ...(open ? list.map((d) => this.closedRow(d, t, collapsed, m)) : [])];
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const diagnostics = (this.renderDiagnostics ??= createRenderDiagnostics()).begin("unknown");
    try {
      const root = this.renderFrame(diagnostics);
      diagnostics.complete();
      return root;
    } catch (error) {
      diagnostics.fail(error);
      throw error;
    }
  }

  renderFrame(diagnostics) {
    diagnostics.stage("native-snapshot");
    const t = theme();
    const collapsed = narrow();
    diagnostics.setMode(collapsed ? "collapsed" : "expanded");
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const colors = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(colors).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(colors).length;
    // Only listed projects get a color; any other folder's space stays white.
    const listedNow = new Set(this.listed());
    for (const p of sp) {
      const want = !p.machine && listedNow.has((p.folder ?? "").replace(/\/+$/, "")) ? hue(project(p)) : p.machine ? hue(project(p)) : null;
      if (kept[p.id] === want || (!want && !kept[p.id])) continue;
      if (want) kept[p.id] = want;
      else delete kept[p.id];
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    // One read of panes and agents per render (each read copies them all).
    const ps = panes(), ag = agents(), terms = terminals(), focus = focused();
    const config = currentSidebarConfig() ?? { options: {} };
    this.config = config;
    this.projects = this.listed();
    if (this.projects.join("\n") !== this.shared) { this.shared = this.projects.join("\n"); setShared("projects.listed", this.projects); }
    diagnostics.stage("grouping", { spaces: sp.length, panes: ps.length, agents: ag.length, terminals: terms.length, projects: this.projects.length });
    const groups = this.assign(sp, ps);
    this.frame = { sp, ps, ag, terms, focus, focusedTerminal: focus?.shown ?? focus?.terminal ?? focus?.agent, colors: kept, ms: machines(), names: shared("projects.names") ?? {}, options: { ...OPTIONS, ...config.options }, byPane: new Map(ag.map((a) => [a.pane, a])), groups, groupMeta: this.groupMeta };
    const failedSetups = new Map();
    for (const term of terms) {
      const cwd = term.labels?.[WORKTREE_LABELS.cwd];
      if (term.state !== "live" || !cwd || term.labels[WORKTREE_LABELS.status] !== "failed") continue;
      const machine = term.address.includes("/") ? term.address.split("/", 1)[0] : null;
      const key = JSON.stringify([machine, normalizeRoot(cwd)]);
      if (!failedSetups.has(key) || term.created_ms > failedSetups.get(key).created_ms) failedSetups.set(key, term);
    }
    this.frame.failedSetups = failedSetups;
    const liveAgents = this.canonicalLiveAgents(sp, ps, ag, terms);
    this.frame.liveAgents = liveAgents;
    this.indexLiveAgents(liveAgents, groups);
    this.workingSets = normalizeWorkingSetsState(shared(WORKING_SETS_STATE));
    this.frame.liveTerminals = new Map(terms.filter(term => term.state === "live").map(term => [term.address, term]));
    diagnostics.stage("recovery-capture-persist", { spaces: sp.length, agents: ag.length, groups: groups.size });
    this.captureRecovery();
    diagnostics.stage("visual-publication", { panes: ps.length, terminals: terms.length, groups: groups.size });
    this.publishVisualGroups(visualSnapshotIdentity({ panes: ps, terminals: terms }));
    diagnostics.stage("hidden-removal", { groups: groups.size });
    this.applyPendingHiddenRemovals();
    // Reduce shared visibility actions and both session observers against the
    // complete frame, including current pane groups and terminal parents.
    diagnostics.stage("visibility-reduce", { agents: ag.length, panes: ps.length, groups: groups.size });
    this.reduceFrameState();
    // Picked sub-rows closed from the selection menu (over9k-menu): once each.
    const closing = shared("over9k.closeSubs");
    if (closing?.at && closing.at !== this.closedAt) { this.closedAt = closing.at; this.closeSubs(closing.list ?? []); this.sel.clear(); }
    this.vis = [];
    this.subPicks = new Map(); // a sub-row's pick -> how it closes (subRows)
    this.loose = [...this.frame.groupMeta.entries()].filter(([key, group]) => key.startsWith("d:") && group.kind === "project")
      .map(([, group]) => group.folder)
      .sort((a, b) => base(a).localeCompare(base(b), undefined, { sensitivity: "base" }));
    this.remoteLoose = [...this.frame.groupMeta.entries()].filter(([key, group]) => key.startsWith("r:") && group.kind === "project")
      .map(([key, group]) => ({ key, folder: group.folder, machine: group.machine }))
      .sort((a, b) => base(a.folder).localeCompare(base(b.folder), undefined, { sensitivity: "base" }));
    diagnostics.stage("list-build", { spaces: sp.length, groups: groups.size });
    const list = this.grouped(t, collapsed);
    this.visible = this.vis;
    diagnostics.stage("final-tree-order", { rows: list.length, visible: this.vis.length, groups: groups.size });
    // Preserve native agent.next / agent.prev ordering, including hidden agents.
    const keys = [...(this.drawn ?? []).map((r) => r.w.id), ...this.loose.map((d) => folderGroupKey(null, d)), ...this.remoteLoose.map((group) => group.key)];
    const byPaneAgent = this.frame.byPane;
    const paneOrder = keys.flatMap((k) => (this.frame.groups.get(k) ?? []).map((x) => byPaneAgent.get(x.p.pane)?.address).filter(Boolean));
    const order = [...paneOrder, ...(this.frame.liveAgents ?? []).map((entry) => entry.address)].filter((address, index, all) => all.indexOf(address) === index);
    if (order.join() !== this.order) { this.order = order.join(); setAgentOrder(order); }
    // Picks of rows that are gone are dropped.
    const alive = new Set([...sp.map((s) => `s:${s.id}`), ...ps.map((p) => `p:${p.pane}`), ...this.loose.map((d) => folderGroupKey(null, d)), ...this.remoteLoose.map((group) => group.key), ...this.projects.map((d) => `c:${d}`), ...this.subPicks.keys()]);
    for (const k of this.sel) if (!alive.has(k)) this.sel.delete(k);
    const none = this.statusView() && !(this.frame.liveAgents ?? []).length;
    const hiddenSnapshot = collapsed ? null : (() => {
      const rows = this.hiddenRows();
      return { rows, groups: this.hiddenGroups(rows) };
    })();
    const showHidden = hiddenSnapshot && this.visibilityState().open ? this.hiddenSection(t, hiddenSnapshot) : null;
    const root = v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .when(!collapsed, (el) => el.child(this.viewBar(t, hiddenSnapshot))
        .child(h_flex().h(25).px(12).gap(8).items_center().text_size(10.5).text_color(t.muted)
          .child(div().id("working-sets").flex_1().truncate().cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click(() => this.openWorkingSets()).child(`Projects: ${this.activeWorkingSet()?.name ?? "All"}`))
          .child(div().id("recover-agents").cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click(() => this.openRecovery()).child("Recover agents"))))
      .when(Boolean(none), (el) => el.child(div().px(16).py(6).text_size(12).text_color(t.dim).child("No agents running.")))
      .child(v_flex().id("spaces-scroll").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(list)
        .when(Boolean(showHidden), (el) => el.child(showHidden)))
      // On its own (no Over9k footer in this window): its help and options here.
      .when(!collapsed && !hasMod(layout(), "over9k-footer"), (el) => el.child(h_flex().id("over9k-options-row").h(32).flex_none().mx(8).mb(6).px(8).gap(9)
        .items_center().rounded(7).cursor_pointer().text_color(t.muted).border_t(1).border_color(t.border)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 740, height: 600, props: { view: "options" } }))
        .child(svg("mods/workspace-chrome/settings.svg").size(14).flex_none()).child("Over9k help & options")));
    this.acknowledgeReload();
    return root;
  }
}


// The "Name: ..." line Claude's recap starts with, once it's there (Claude may
// say something before reading the transcript, so any of its replies counts).
function recapName(jsonl) {
  for (const line of (jsonl ?? "").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== "assistant") continue;
    const text = (Array.isArray(m.message?.content) ? m.message.content : []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const got = text.match(/^\s*\**Name:\**\s*(.+)$/m)?.[1].replace(/[*`"]/g, "").trim().slice(0, 60);
    if (got) return got;
  }
  return undefined;
}
