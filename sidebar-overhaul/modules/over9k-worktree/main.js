// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { branch, tab, argv }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { agents, run, props, closeOverlay, openOverlay, theme, spaces, panes, terminals, shared, setShared, exec, home, appHome, readTextFile } from "herdr";
import { flatDestination, machineKey, parseConfig } from "../../config.js";
const VISIBILITY_ACTIONS = "herdr-custom.agentVisibility.actions";
import { buildClosePlan, closePlanIdentity, mergeRecoveryState } from "./close-plan.js";

const sidebarConfigPath = () => `${appHome()}/mods/sidebar-overhaul/sidebar.config.json`;
const loadSidebarConfig = async () => {
  let text;
  try { text = await readTextFile(sidebarConfigPath()); }
  catch (error) { throw new Error(`Could not read sidebar.config.json: ${String(error?.message ?? error)}`); }
  if (typeof text !== "string" || !text.trim()) throw new Error("Could not read sidebar.config.json: file is missing or empty.");
  try { return parseConfig(text); }
  catch (error) { throw new Error(`Invalid sidebar.config.json: ${String(error?.message ?? error)}`); }
};
import { createWorktree, hookGateArgv, resolveHookPlan } from "./worktree-hooks.js";
import { hookPreflight } from "../over9k-worktree-settings/settings.js";
const queueRevealLaunch = (machine, folder) => {
  if (typeof setShared !== "function") return;
  const before = [...new Set((terminals() ?? []).map((item) => item?.address).filter(Boolean))];
  const queued = typeof shared === "function" ? shared(VISIBILITY_ACTIONS) : [];
  setShared(VISIBILITY_ACTIONS, [...(Array.isArray(queued) ? queued : []), {
    type: "reveal-launch",
    machine: machine ?? null,
    folder: String(folder ?? "").replace(/\\/g, "/").replace(/\/+$/, ""),
    before,
  }]);
};

const revealForWorktree = (path) => {
  if (typeof setShared !== "function") return;
  const folder = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!folder) return;
  const panesByAddress = new Map((panes() ?? []).filter((pane) => pane?.terminal).map((pane) => [pane.terminal, pane]));
  const items = [...(terminals() ?? []), ...(agents() ?? [])].filter((item) => item?.address);
  const byAddress = new Map(items.map((item) => [item.address, item]));
  const target = items.find((item) => {
    const cwd = String(item.cwd ?? panesByAddress.get(item.address)?.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return cwd === folder;
  });
  if (!target) return;
  const addresses = [];
  const entries = {};
  const seen = new Set();
  let address = target.address;
  while (address && !seen.has(address)) {
    seen.add(address);
    addresses.push(address);
    const item = byAddress.get(address) ?? {};
    entries[address] = Number.isFinite(Number(item.created_ms)) ? { created_ms: Number(item.created_ms) } : {};
    address = item.parent ?? null;
  }
  const queued = typeof shared === "function" ? shared(VISIBILITY_ACTIONS) : [];
  setShared(VISIBILITY_ACTIONS, [...(Array.isArray(queued) ? queued : []), { type: "reveal", addresses, entries }]);
};

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

function closePlanFor(spaceId) {
  if (!spaceId) return null;
  return buildClosePlan({ spaces: [spaceId] }, {
    spaces: spaces() ?? [],
    panes: panes() ?? [],
    agents: agents() ?? [],
    terminals: terminals() ?? [],
    recovery: shared("over9k.recovery"),
    now: Date.now(),
  });
}

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  const leaf = main.split(/[\\/]/).pop();
  return { top: top.out, main, name: main === common.out ? leaf.replace(/\.git$/, "") : leaf, linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.settingUp = props()?.action === "setup";
    this.text = props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.existingCheckout = null; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus(); // the root is mounted from the first frame: keep the keyboard here while loading
    if (this.opening || props()?.action === "new") this.input.focus();
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.removalCheckout = null;
    this.removed = false;
    this.closeRequested = false;
    this.closePlan = null;
    this.affectedAgents = [];
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        const space = this.space();
        const creating = props()?.action === "new";
        this.folder = props()?.folder || (creating || this.settingUp ? space?.folder : place(space)) || (this.settingUp ? null : this.userHome);
        if (!this.folder) throw new Error("The checkout is no longer available.");
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        if (repo && creating) {
          const head = await git(repo.top, ["rev-parse", "--verify", "HEAD^{commit}"], this.on);
          if (!head.ok) throw new Error(head.err || "Could not read the checkout’s HEAD.");
          this.sourceCommit = head.out;
          const branch = await git(repo.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], this.on);
          this.sourceLabel = branch.ok ? `${branch.out} (${head.out.slice(0, 12)})` : `detached HEAD (${head.out.slice(0, 12)})`;
          this.worktreeRoot = (await loadSidebarConfig()).machines[machineKey(this.on ?? null)]?.worktreeDirectory;
          this.hookPlan = await this.readHooks({ machine: this.on ?? null, main: repo.main });
        }
        if (repo && this.settingUp) this.hookPlan = await this.readHooks({ machine: this.on ?? null, main: repo.main });
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
          this.closePlan = closePlanFor(this.space()?.id);
          this.affectedAgents = this.closePlan?.affectedAgents ?? [];
          const branch = await git(repo.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], this.on);
          this.removeBranch = branch.ok && branch.out ? branch.out : null;
          const origin = await git(repo.main, ["remote", "get-url", "--push", "origin"], this.on);
          this.removeOrigin = origin.ok ? origin.out : "";
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        this.repo = repo;
        cx.notify();
        // The list (and with it the filter input) only mounts once loading is
        // done, so the keyboard must move there now — a focus call made while
        // loading lands on nothing and the dialog stays keyboard-dead.
        this.handle.focus();
        if (this.opening || creating) cx.timer.after(100, () => this.input.focus());
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy || !this.repo) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = this.settingUp ? await this.setup() : props().action === "remove" ? await this.remove() : await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error && !this.existingCheckout) this.close();
    cx.notify();
  }

  async readHooks({ machine, main }) {
    let text;
    try { text = await readTextFile(`${appHome()}/worktree-hooks.json`); }
    catch (error) { return { hooks: [], error: `Could not read worktree-hooks.json: ${String(error)}` }; }
    const plan = await resolveHookPlan(text, machine, main, async cwd => {
      const result = await git(cwd, ["config", "--local", "--get", "remote.origin.url"], this.on);
      if (!result.ok && result.err) throw new Error(result.err);
      return result.ok ? result.out : null;
    });
    if (plan.error) return plan;
    return { ...plan, preflightError: await hookPreflight(plan.hooks, machine, exec) };
  }

  async setup() {
    const { top, main } = this.repo;
    const current = await repoOf(top, this.on);
    if (!current || current.top !== top || current.main !== main) return "The checkout changed. Reopen setup to review it again.";
    const latest = await this.readHooks({ machine: this.on ?? null, main });
    const same = JSON.stringify(this.hookPlan) === JSON.stringify(latest);
    this.hookPlan = latest;
    if (latest.error || latest.preflightError) return latest.error || latest.preflightError;
    if (!latest.hooks.length) return "No setup hooks are configured for this checkout.";
    if (!same) return "Setup checks or hooks changed. Review them before running setup.";
    const existing = spaces().find(space => (space.machine ?? null) === (this.on ?? null) && space.folder === top);
    const argv = hookGateArgv(latest.hooks, [], { repo: main, cwd: top, ruleRepo: latest.ruleRepo });
    if (existing) await this.appCommand("tab.new", { space: existing.id, folder: top, name: "Worktree setup", argv });
    else await this.launchCheckout({ folder: top, machine: this.on ?? "", tab: "Worktree setup", argv });
    return "";
  }

  launchCheckout(args) { return this.appCommand("space.new", args); }

  async appCommand(name, args) {
    const result = await exec("herdr-app", ["do", name, JSON.stringify(args)], { timeout: 30_000 });
    if (result.code !== 0) throw new Error(result.stderr?.trim() || `Herdr refused ${name}.`);
    const response = JSON.parse(result.stdout);
    if (response?.error) throw new Error(response.error);
  }

  async create() {
    const p = props();
    if (this.pendingLaunch) {
      const args = this.pendingLaunch;
      const existing = spaceOf(args.folder, [{ path: args.folder }], this.on, spaces(), panes());
      if (existing) run("space.select", { id: existing.id });
      else await this.launchCheckout(args);
      this.pendingLaunch = null;
      return "";
    }
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const config = await loadSidebarConfig();
    const root = config.machines[machineKey(this.on ?? null)]?.worktreeDirectory;
    if (this.sourceCommit && root !== this.worktreeRoot) {
      this.worktreeRoot = root;
      return "The worktree folder changed. Review the new destination before creating it.";
    }
    if (root) {
      const access = await exec("sh", ["-c", 'test -d "$1" && test -w "$1" && test -x "$1"', "sh", root], { on: this.on });
      if (access.code !== 0) return `New worktree folder must exist and be writable: ${root}`;
    }
    const current = await checkouts(this.repo, this.on);
    this.existingCheckout = current.find(checkout => checkout.branch === branch) ?? null;
    if (this.existingCheckout) { this.list = current; return ""; }
    const readHooks = async target => {
      const latest = await this.readHooks(target);
      if (this.hookPlan && JSON.stringify(latest) !== JSON.stringify(this.hookPlan)) {
        this.hookPlan = latest;
        return { ...latest, error: latest.error || "The setup hooks changed. Review them before creating the worktree." };
      }
      return latest.preflightError ? { ...latest, error: latest.preflightError } : latest;
    };
    return createWorktree({
      branch,
      sourceCommit: this.sourceCommit,
      repo: this.repo,
      config,
      existingDestinations: current.map((checkout) => checkout.path),
      machine: this.on ?? null,
      pathExists: async (path) => {
        const result = await exec("sh", ["-c", 'test -e "$1" || test -L "$1"', "sh", path], { on: this.on });
        return result?.code === 0;
      },
      tab: p.tab,
      requestedArgv: p.argv ?? ["bash", "-lc", "exec omp"],
      git,
      readHooks,
      runSpace: async args => {
        this.pendingLaunch = args;
        try { await this.launchCheckout(args); }
        catch (error) { throw new Error(`Checkout created at ${args.folder}, but Herdr could not open it: ${error.message}`); }
        this.pendingLaunch = null;
      },
    });
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c, shell = false) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) {
      revealForWorktree(c.path);
      run("space.select", { id: s.id });
      if (shell) run("tab.new", { space: s.id, folder: c.path });
    } else {
      queueRevealLaunch(this.on, c.path);
      run("space.new", { folder: c.path, machine: this.on ?? "", ...(shell ? {} : { argv: ["bash", "-lc", "exec omp"] }) });
    }
  }

  async remove() {
    if (this.removed) return this.cleanBranches();
    const s = this.space();
    if (!s?.id && !this.closeRequested) return "The worktree space is not available to close safely.";
    if (this.closeRequested) {
      const current = await repoOf(this.repo.top, this.on);
      if (!current?.linked || current.top !== this.removalCheckout.path || current.main !== this.removalCheckout.main)
        return "The checkout changed. Reopen the removal dialog before retrying.";
    }
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Review the warnings, then select Yes again.";
    const actualSpace = s?.id ? spaces().find(candidate => candidate.id === s.id) : null;
    const latestPlan = actualSpace && closePlanFor(actualSpace.id);
    const latestIdentity = latestPlan && closePlanIdentity(latestPlan);
    if (!this.closeRequested) {
      if (!actualSpace) return "The worktree space is no longer available to close safely.";
      const previousIdentity = this.closePlan && closePlanIdentity(this.closePlan);
      this.closePlan = latestPlan;
      this.affectedAgents = latestPlan?.affectedAgents ?? [];
      if (!previousIdentity || previousIdentity !== latestIdentity) return "The affected terminals or agents changed. Review the complete list, then select Yes again.";
    }
    const branch = await git(this.repo.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], this.on);
    if ((branch.ok && branch.out ? branch.out : null) !== this.removeBranch) {
      this.removeBranch = branch.ok && branch.out ? branch.out : null;
      this.deleteLocal = this.deleteOrigin = false;
      return "The checked-out branch changed. Review the cleanup options again.";
    }
    if (this.deleteOrigin) {
      const origin = await git(this.repo.main, ["remote", "get-url", "--push", "origin"], this.on);
      if (!origin.ok || origin.out !== this.removeOrigin) return "The origin push destination changed. Reopen this dialog before removing it.";
      const ref = `refs/heads/${this.removeBranch}`;
      const remote = await git(this.repo.main, ["ls-remote", "--heads", "--", this.removeOrigin, ref], this.on, 30_000);
      if (!remote.ok) return remote.err || "Could not verify the origin branch.";
      const remoteBranch = remote.out.split("\n").map(line => line.split("\t")).find(([, name]) => name === ref);
      this.originTip = remoteBranch?.[0];
      if (this.originTip && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(this.originTip)) return "Could not verify the origin branch tip.";
    }
    if (!this.closeRequested) {
      if (closePlanIdentity(closePlanFor(actualSpace.id)) !== latestIdentity) return "The affected terminals or agents changed. Review the complete list, then select Yes again.";
      setShared("over9k.recovery", mergeRecoveryState(shared("over9k.recovery"), latestPlan?.affectedAgents ?? []));
      try { await this.appCommand("space.close", { id: actualSpace.id, confirmed: true }); }
      catch (error) { return `Could not confirm that the worktree space closed: ${String(error)}`; }
      this.removalCheckout = { id: actualSpace.id, path: this.repo.top, main: this.repo.main };
      this.closeRequested = true;
    }
    const checkout = this.removalCheckout;
    const replacement = spaces().some(candidate => candidate.id === checkout.id || (candidate.machine ?? null) === (this.on ?? null) && candidate.folder?.replace(/\/+$/, "") === checkout.path);
    if (replacement) return "A space for this checkout is still open. Retry after it is closed.";
    const force = this.dirty || mods.length > 0;
    const r = await git(checkout.main, ["worktree", "remove", ...(force ? ["--force"] : []), checkout.path], this.on, 600_000);
    if (!r.ok) return r.err || "git worktree remove failed.";
    this.removed = true;
    return this.cleanBranches();
  }

  async cleanBranches() {
    const errors = [];
    if (this.deleteOrigin) {
      const ref = `refs/heads/${this.removeBranch}`;
      const push = this.originTip ? await git(this.repo.main, ["push", `--force-with-lease=${ref}:${this.originTip}`, "--", this.removeOrigin, `:${ref}`], this.on, 60_000) : { ok: true };
      if (push.ok) this.deleteOrigin = false;
      else errors.push(`Origin branch kept: ${push.err || "push failed"}`);
    }
    if (this.deleteLocal) {
      const result = await git(this.repo.main, ["branch", "-d", "--", this.removeBranch], this.on);
      if (result.ok) this.deleteLocal = false;
      else errors.push(`Local branch kept: ${result.err || "branch deletion failed"}`);
    }
    return errors.length ? `Worktree removed. ${errors.join(" · ")}` : "";
  }

  key(e, cx) {
    if (e.key === "escape" && !this.busy) return this.close();
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(64)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")))
        .child(h_flex().gap(10).children(this.checkoutActions(c, t)));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  checkoutActions(c, t) {
    return [["omp", "Open in OMP", () => this.open(c)], ["shell", "Open shell", () => this.open(c, true)], ["copy", "Copy path", cx => cx.write_to_clipboard(c.path)], ["setup", "Run setup…", () => {
      this.close();
      openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 560, height: 420, props: { view: "worktree", action: "setup", folder: c.path, machine: this.on ?? null } });
    }]]
      .map(([id, label, action]) => div().id(`${id}-${c.path}`).cursor_pointer().text_size(11).text_color(t.accent)
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label));
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    if (this.settingUp) {
      const plan = this.hookPlan;
      const problem = plan?.error || plan?.preflightError || this.error || (this.repo === null ? "This folder is not a Git checkout." : "");
      return v_flex().id("worktree-setup").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx)).size_full().p(16).gap(10).bg(t.popover)
        .child(div().font_semibold().text_color(t.foreground).child("Run worktree setup"))
        .child(div().text_color(t.muted).child(`${this.on ?? "This computer"} · ${this.repo?.top ?? this.folder ?? "Loading checkout…"}`))
        .children((plan?.hooks ?? []).map((hook, index) => div().text_color(t.foreground).child(`${index + 1}. ${hook.name}`)))
        .when(Boolean(problem), el => el.child(div().text_color(t.blocked).child(problem)))
        .when(Boolean(plan && !problem && !plan.hooks.length), el => el.child(div().text_color(t.muted).child("No setup hooks are configured for this checkout.")))
        .when(Boolean(this.repo && !this.busy && plan && (plan.hooks.length || plan.error)), el => el.child(div().id("worktree-run-setup").cursor_pointer().text_color(t.accent)
          .on_click((_e, cx) => this.go(cx)).child(plan.error || plan.preflightError ? "Check again" : "Run setup in a new terminal")))
        .when(this.busy, el => el.child(div().text_color(t.muted).child("Checking setup…")));
    }
    const remove = props()?.action === "remove";
    const s = this.space();
    const r = this.repo;
    const title = remove ? `Remove worktree ${s?.name ?? ""}?` : `New worktree${r ? ` of ${r.name}` : ""}`;
    const detail =
      r === undefined
        ? "…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : this.removed ? "Worktree removed. You can retry any remaining branch cleanup." : `Closes the space and deletes ${tilde(r.top, this.userHome)}. Branches stay unless selected below.`
            : this.sourceLabel ? `Start from ${this.sourceLabel}. Uncommitted edits stay in the original checkout.` : "Creates the checkout under the configured machine worktree root.";
    const affectedAgentRows = (this.affectedAgents ?? []).map((agent, index) => {
      const detail = this.closePlan?.agentStatuses?.find((item) => item.address === agent.address);
      const owner = agent.owner?.name || agent.visual?.label || agent.cwd || "";
      return div().id(`affected-agent-${index}`).flex_none().text_size(11).text_color(t.muted)
        .child(`${agent.title || agent.address}${owner ? ` · ${owner}` : ""}${detail?.status ? ` · ${detail.status}` : ""}`);
    });
    const blocked = !r || (remove && !r.linked);
    let destination = "";
    if (!remove && r && this.worktreeRoot && this.text.trim()) {
      try { destination = flatDestination(this.worktreeRoot, r.name, this.text.trim()); } catch {}
    }
    const button = (id, label, action, primary = false) => div().id(id).px(12).py(6).rounded(6)
      .bg(primary ? t.selected : t.raised).text_color(t.foreground).cursor_pointer().on_click((_e, cx) => action(cx)).child(label);
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(remove && this.closePlan, (el) => el.child(
        v_flex().flex_none().gap(4).p(8).rounded(7).border_1().border_color(t.border)
          .child(div().font_semibold().text_color(t.foreground).child(`Affected agents (${affectedAgentRows.length})`))
          .when((this.closePlan?.working ?? 0) > 0, (x) => x.child(div().text_color(t.blocked).child(`${this.closePlan.working} agent${this.closePlan.working === 1 ? "" : "s"} still working or blocked.`)))
          .when(affectedAgentRows.length === 0, (x) => x.child(div().text_size(11).text_color(t.dim).child("None.")))
          .children(affectedAgentRows),
      ))
      .when(remove && this.dirty, (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
      .when(remove && this.unpushed.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
      .when(remove && !blocked && Boolean(this.removeBranch) && !this.removed && !this.busy, el => el.child(h_flex().gap(8)
        .child(button("worktree-delete-local", `${this.deleteLocal ? "☑" : "☐"} Delete local branch`, cx => { this.deleteLocal = !this.deleteLocal; cx.notify(); }))
        .when(Boolean(this.removeOrigin), row => row.child(button("worktree-delete-origin", `${this.deleteOrigin ? "☑" : "☐"} Delete from origin`, cx => { this.deleteOrigin = !this.deleteOrigin; cx.notify(); })))
        .child(div().text_color(t.muted).child(`Branch: ${this.removeBranch}`))))
      .when(!remove && !blocked && !this.pendingLaunch, (el) =>
        el.child(
          Input.new(this.input)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(this.inputFocused ? t.accent : t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(Boolean(destination) && !this.existingCheckout, el => el.child(div().text_color(t.muted).truncate().tooltip(destination).child(`Destination: ${destination}`)))
      .when(Boolean(this.existingCheckout), el => el.child(div().text_color(t.muted).child(`Existing checkout: ${this.existingCheckout.path}`))
        .child(h_flex().gap(10).children(this.checkoutActions(this.existingCheckout, t))))
      .when(!remove && !this.existingCheckout && !this.pendingLaunch && Boolean(this.hookPlan), el => el.child(div().text_color(this.hookPlan.error || this.hookPlan.preflightError ? t.blocked : t.muted)
        .child(this.hookPlan.error || this.hookPlan.preflightError ? `Setup could not be verified: ${this.hookPlan.error || this.hookPlan.preflightError}` : this.hookPlan.hooks.length
          ? `Setup hooks: ${this.hookPlan.hooks.map(hook => hook.name).join(" → ")}` : "No setup hooks configured.")))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .gap(6)
          .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .when(remove && !this.busy, el => el
            .child(button("worktree-remove-no", this.removed || blocked ? "Close" : "No", () => this.close()))
            .when(!blocked, row => row.child(button("worktree-remove-yes", this.removed ? "Retry cleanup" : this.closeRequested ? "Retry removal" : "Yes", cx => this.go(cx), true))))
          .when(this.busy || (!remove && blocked), el => el.child(this.busy ? "working…" : "esc close"))
          .when(!remove && !this.busy && !blocked && !this.existingCheckout, el => el.child(button("worktree-create-confirm", this.pendingLaunch ? "Open worktree" : "Create worktree", cx => this.go(cx), true)))
      );
  }
}
