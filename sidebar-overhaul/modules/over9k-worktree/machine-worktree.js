import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { appHome, closeOverlay, exec, openOverlay, props, readTextFile, run, spaces, theme, writeTextFile } from "herdr";
import { flatDestination, parseConfig } from "../../config.js";
import { checkoutMachineWorktree, githubBranches, githubRepositories, machineWorktreeRoot, previewMachineWorktree } from "./machine-worktree-git.js";

const rowsId = "machine-worktree-results";
const recentRank = (recent, field, value) => {
  const index = recent.findIndex(item => item[field] === value);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
};
const configPath = () => `${appHome()}/mods/sidebar-overhaul/sidebar.config.json`;
/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("./machine-worktree-git.js").Repository} Repository */

const errorText = (/** @type {unknown} */ error) => error instanceof Error ? error.message : String(error);

/** @param {string} folder @param {string | null} machine */
function openMachineCheckout(folder, machine, shell = false) {
  const existing = checkoutSpace(folder, machine);
  if (existing) {
    run("space.select", { id: existing.id });
    if (shell) run("tab.new", { space: existing.id, folder });
  } else run("space.new", { folder, machine: machine ?? "", ...(shell ? {} : { argv: ["bash", "-lc", "exec omp"] }) });
}

function checkoutSpace(folder, machine) {
  return spaces().find(space => (space.machine || null) === machine && space.folder?.replace(/\/+$/, "") === folder.replace(/\/+$/, ""));
}

export default class MachineWorktree extends View {
  /** @param {import("gpui-shell").Props} viewProps @param {Context} cx */
  init(viewProps, cx) {
    const p = viewProps?.view ? viewProps : props();
    this.machine = p.machine ?? null;
    this.overlay = p.overlay ?? props()?.overlay;
    /** @type {string} */
    this.root = "";
    /** @type {Repository[]} */
    this.repositories = [];
    /** @type {string[]} */
    this.branches = [];
    this.at = 0;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.handle.focus();
    this.load(cx);
  }

  setInput(placeholder, value = "") {
    const previous = this.input;
    this.input = InputState.new({ placeholder, value });
    this.input.on("change", (_e, cx) => { this.cached = null; this.existing = null; this.reviewed = null; this.checkoutError = ""; this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.choose(cx));
    previous?.release();
  }

  /** @param {Context} cx @param {Repository | null} repo */
  load(cx, repo = null) {
    this.repo = repo;
    this.error = "";
    this.loading = true;
    this.at = 0;
    this.setInput(repo ? "Filter branches…" : "Filter repositories…", repo ? "" : this.repoQuery ?? "");
    cx.timer.after(100, () => this.input.focus());
    this.scroll.scroll_to_item(0);
    cx.spawn(async cx => {
      try {
        if (!this.root) this.root = machineWorktreeRoot(parseConfig(await readTextFile(configPath())), this.machine);
        if (repo) {
          this.branches = await githubBranches(exec, repo);
          const recent = (await this.recentWorktrees()).filter(item => item.repo === repo.name);
          this.branches.sort((a, b) => recentRank(recent, "branch", a) - recentRank(recent, "branch", b));
        }
        else {
          this.repositories = await githubRepositories(exec);
          const recent = await this.recentWorktrees();
          this.repositories.sort((a, b) => recentRank(recent, "repo", a.name) - recentRank(recent, "repo", b.name));
        }
      } catch (error) { this.error = errorText(error); }
      this.loading = false;
      cx.notify();
    });
    cx.notify();
  }

  rows() {
    const query = this.input.value().trim().toLowerCase().split(/\s+/);
    return (this.repo ? this.branches : this.repositories).filter(row => {
      const name = (typeof row === "string" ? row : row.name).toLowerCase();
      return query.every(word => name.includes(word));
    });
  }

  creation() {
    const branch = this.input.value().trim();
    const source = this.source;
    return branch && source ? { branch, source } : null;
  }

  /** @param {string} source @param {Context} cx */
  branchFrom(source, cx, name = "") {
    this.cached = this.existing = this.reviewed = null;
    this.checkoutError = "";
    this.source = source;
    this.setInput("New branch name…", name);
    cx.timer.after(100, () => this.input.focus());
    cx.notify();
  }

  runSetup() {
    openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 560, height: 420, props: { view: "worktree", action: "setup", folder: this.existing, machine: this.machine } });
  }

  /** @param {Context} cx @param {Repository | string} [row] @param {string} [cachedCommit] */
  choose(cx, row = this.rows()[this.at], cachedCommit) {
    if (this.launchArgs) return this.retryLaunch(cx);
    if (this.loading || this.busy || this.error || this.existing || (this.cached && !cachedCommit)) return;
    const creation = this.creation();
    if (this.source && !creation) return;
    if (creation) row = creation.branch;
    if (!row) return;
    if (typeof row !== "string") {
      this.repoQuery = this.input.value();
      this.branches = [];
      this.load(cx, row);
      return;
    }
    const repo = this.repo;
    if (cachedCommit && this.branches.includes(row)) {
      this.checkoutError = `Branch already exists on GitHub: ${row}`;
      this.cached = null;
      cx.notify();
      return;
    }
    if (!repo) return;
    const source = creation?.source;
    const preview = this.reviewed;
    this.busy = true;
    this.checkoutError = "";
    this.progress = preview ? `Checking out ${row}…` : "Reading setup hooks…";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const root = machineWorktreeRoot(parseConfig(await readTextFile(configPath())), this.machine);
        this.root = root;
        const hooksText = await readTextFile(`${appHome()}/worktree-hooks.json`);
        if (!preview || preview.branch !== row || preview.sourceBranch !== source) {
          const review = await previewMachineWorktree({ exec, machine: this.machine, root, repo, branch: row, hooksText, source });
          if (review.error) throw new Error(`Could not verify setup hooks: ${review.error}`);
          this.reviewed = { ...review, branch: row, sourceBranch: source };
          return;
        }
        this.reviewed = null;
        this.cached = null;
        if (preview.path !== flatDestination(root, repo.name, row)) throw new Error("Destination changed since review. Review it again before creating the worktree.");
        const result = await checkoutMachineWorktree({ exec, machine: this.machine, root, repo, branch: row, hooksText, source, cachedCommit, reviewedHooks: preview.hooks, reviewedRuleRepo: preview.ruleRepo });
        if (result.existingFolder) { this.existing = result.existingFolder; return; }
        if (result.cachedCommit) { this.reviewed = preview; this.cached = result.cachedCommit; return; }
        this.launchArgs = result;
        await this.rememberWorktree(repo.name, row).catch(() => {});
        await this.launchCheckout();
      } catch (error) {
        this.checkoutError = this.launchArgs ? `Checkout created at ${this.launchArgs.folder}, but Herdr could not open it: ${errorText(error)}` : errorText(error);
      } finally { this.progress = ""; this.busy = false; cx.notify(); }
    });
  }

  async launchCheckout() {
    const args = this.launchArgs;
    const existing = checkoutSpace(args.folder, this.machine);
    if (existing) run("space.select", { id: existing.id });
    else {
      const result = await exec("herdr-app", ["do", "space.new", JSON.stringify(args)], { timeout: 30_000 });
      if (result.code !== 0) throw new Error(result.stderr?.trim() || "Herdr refused the launch.");
      const response = JSON.parse(result.stdout);
      if (response?.error) throw new Error(response.error);
    }
    this.launchArgs = null;
    closeOverlay(this.overlay);
  }

  retryLaunch(cx) {
    if (this.busy || !this.launchArgs) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async cx => {
      try { await this.launchCheckout(); }
      catch (error) { this.checkoutError = errorText(error); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  async rememberWorktree(repo, branch) {
    const path = `${appHome()}/mods/sidebar-overhaul/worktree-recent.json`;
    let recent = {};
    try { recent = JSON.parse(await readTextFile(path)); } catch {}
    const key = this.machine ?? "local";
    recent[key] = [{ repo, branch }, ...(Array.isArray(recent[key]) ? recent[key].filter(item => item.repo !== repo || item.branch !== branch) : [])].slice(0, 12);
    await writeTextFile(path, JSON.stringify(recent));
  }

  async recentWorktrees() {
    try {
      const data = JSON.parse(await readTextFile(`${appHome()}/mods/sidebar-overhaul/worktree-recent.json`));
      const rows = data[this.machine ?? "local"];
      return Array.isArray(rows) ? rows.filter(item => typeof item.repo === "string" && typeof item.branch === "string") : [];
    } catch { return []; }
  }


  /** @param {Context} cx */
  back(cx) {
    if (this.busy || this.loading) return;
    this.reviewed = null;
    this.source = "";
    this.repo = null;
    this.error = "";
    this.checkoutError = "";
    this.at = 0;
    this.setInput("Filter repositories…", this.repoQuery ?? "");
    this.scroll.scroll_to_item(0);
    cx.timer.after(100, () => this.input.focus());
    cx.notify();
  }

  render() {
    const t = /** @type {Record<string, `#${string}`>} */ (theme());
    const rows = this.source ? [] : this.rows();
    const creation = this.creation();
    const selected = creation?.branch ?? rows[this.at];
    const compact = Boolean(this.source || creation || this.reviewed);
    let path = "";
    let destinationError = "";
    if (typeof selected === "string" && this.repo && this.root) {
      try { path = flatDestination(this.root, this.repo.name, selected); } catch (error) { destinationError = errorText(error); }
    }
    /** @param {string} id @param {string} label @param {(cx: Context) => void} click */
    const button = (id, label, click, primary = false) => div().id(id).px(11).py(7).rounded(6).flex_none()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).cursor_pointer()
      .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => click(cx)).child(label);
    return v_flex().id("machine-worktree").track_focus(this.handle).size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (this.busy) { cx.stop_propagation(); return; }
        if (e.key === "escape") {
          if (!this.busy) closeOverlay(this.overlay);
        } else if (!compact && !this.loading && rows.length && (e.key === "down" || e.key === "up")) {
          this.cached = null;
          this.existing = null;
          this.reviewed = null;
          this.checkoutError = "";
          this.at = (this.at + (e.key === "down" ? 1 : rows.length - 1)) % rows.length;
          this.scroll.scroll_to_item(this.at);
          cx.notify();
        } else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().gap(8)
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().text_size(19).text_color(t.foreground).child("New worktree"))
          .child(div().text_size(12).text_color(t.muted).child(this.machine ?? "This computer")))
        .when(Boolean(this.source) && !this.busy, el => el.child(button("machine-worktree-cancel-source", "Back to branches", cx => {
          this.source = "";
          this.cached = this.existing = this.reviewed = null;
          this.checkoutError = "";
          this.at = 0;
          this.scroll.scroll_to_item(0);
          this.setInput("Filter branches…");
          cx.timer.after(100, () => this.input.focus());
          cx.notify();
        })))
        .when(Boolean(this.repo) && !this.loading && !this.busy, el => el.child(button("machine-worktree-back", "Change repository", cx => this.back(cx))))
        .when(!this.busy, el => el.child(button("machine-worktree-close", "Close", () => closeOverlay(this.overlay)))))
      .child(div().text_color(t.foreground).font_medium().child(this.source ? "New branch name" : this.repo ? `Branches in ${this.repo.name}` : "GitHub repositories"))
      .child(this.busy ? div().text_color(t.muted).child(this.input.value()) : Input.new(this.input).h(36).px(10).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground))
      .when(Boolean(this.source) && !this.reviewed, el => el.child(div().text_color(t.muted).child(`Based on ${this.repo.name} / ${this.source}`)))
      .when(!compact, view => view.child(div().relative().flex_1().min_h(0).overflow_hidden().rounded(7).border_1().border_color(t.border)
        .when(this.loading || Boolean(this.error) || !rows.length, el => el.child(div().p(12).text_color(this.error ? t.blocked : t.muted)
          .child(this.error || (this.loading ? (this.repo ? "Loading branches…" : "Loading repositories…")
            : this.input.value().trim() ? (this.repo ? "No matching branches." : "No matching repositories.") : this.repo ? "This repository has no branches." : "No repositories found for your GitHub account."))
          .when(!this.loading && !this.error && !rows.length && Boolean(this.repo?.defaultBranch && this.input.value().trim()), el => el.child(button("machine-worktree-create", `New branch from ${this.repo.defaultBranch}…`, cx => this.branchFrom(this.repo.defaultBranch, cx, this.input.value().trim()), true)))))
        .when(!this.loading && !this.error && rows.length > 0, el => el
          .child(v_virtual_list(rowsId, rows.length, 38, i => {
            const row = rows[i];
            return typeof row === "string" ? row : row.name;
          }, ({ start, end }) => rows.slice(start, end).map((row, index) => {
            const name = typeof row === "string" ? row : row.name;
            const detail = typeof row === "string" ? (row === this.repo?.defaultBranch ? "Default branch" : "") : row.private ? "Private" : "Public";
            return h_flex().px(12).items_center().gap(8).h_full()
              .bg(start + index === this.at ? t.selected : t.popover).hover(s => s.bg(t.hover)).cursor_pointer()
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(name))
              .child(div().flex_none().text_size(11).text_color(t.muted).child(detail));
          })).track_scroll(this.scroll).on_item_click((key, cx) => {
            if (this.busy) return;
            const index = rows.findIndex(row => (typeof row === "string" ? row : row.name) === key);
            if (index < 0) return;
            this.at = index;
            this.cached = null;
            this.existing = null;
            this.reviewed = null;
            if (this.repo) cx.notify();
            else this.choose(cx, rows[index]);
          }).on_item_secondary_click((key, _event, cx) => {
            if (!this.repo || this.busy || !rows.includes(key)) return;
            cx.stop_propagation();
            this.branchFrom(key, cx);
          }).size_full())
          .child(Scrollbar.vertical(rowsId).viewport_from_layout().absolute().inset_0()))))
      .when(Boolean(this.checkoutError || this.progress), el => el.child(div().text_color(this.checkoutError ? t.blocked : t.muted).child(this.checkoutError || this.progress)))
      .when(Boolean(this.reviewed) && !this.busy, el => el.child(v_flex().gap(6).p(12).rounded(7).border_1().border_color(t.border).bg(t.background)
        .child(div().font_medium().text_color(t.foreground).child("Review worktree"))
        .child(div().text_color(t.muted).child(`Source: ${this.repo.name} / ${this.reviewed.source}`))
        .when(Boolean(creation), row => row.child(div().text_color(t.foreground).child(`New branch: ${creation.branch}`)))
        .child(div().text_color(t.muted).child(`Destination: ${this.reviewed.path}`))
        .child(div().text_color(t.foreground).child(this.reviewed.hooks.length ? "Setup hooks (before OMP)" : "No setup hooks configured for this repository on this machine."))
        .children(this.reviewed.hooks.map((hook, i) => div().text_color(t.foreground).child(`${i + 1}. ${hook.name}`)))))
      .when(Boolean(this.cached), el => el.child(div().text_color(t.muted).child(`GitHub is unreachable. Cached ${creation?.source ?? "branch"} (${this.cached.slice(0, 12)}) may be stale. The new name cannot be checked on GitHub while offline.`)))
      .when(Boolean(this.existing), el => el.child(div().text_color(t.muted).child(`This branch already has a worktree: ${this.existing}`)))
      .child(h_flex().items_center().gap(10)
        .child(v_flex().flex_1().min_w(0).when(!this.reviewed, el => el
          .child(div().text_size(11).text_color(t.muted).child(this.repo ? "Destination" : "Worktree folder"))
          .child(div().truncate().text_color(destinationError ? t.blocked : t.foreground).child(destinationError || path || this.root || "—"))))
        .when(Boolean(this.error) && !this.busy, el => el.child(button("machine-worktree-retry", "Retry", cx => this.load(cx, this.repo))))
        .when(!this.error && !this.loading && !this.busy && !this.cached && !this.existing && !this.launchArgs, el => el
          .when(!creation && typeof selected === "string" && Boolean(this.repo), x => x.child(button("machine-worktree-branch-from", "New branch from this…", cx => { if (typeof selected === "string") this.branchFrom(selected, cx); })))
          .when(Boolean(selected) && (!this.repo || Boolean(path)), x => x.child(button("machine-worktree-submit", this.reviewed ? "Create worktree" : this.repo ? "Review worktree" : "Choose repository", cx => this.choose(cx), true))))
        .when(Boolean(this.cached) && !this.busy, el => el.child(button("machine-worktree-use-cache", "Use cached commit", cx => this.choose(cx, undefined, this.cached), true)))
        .when(Boolean(this.launchArgs) && !this.busy, el => el.child(button("machine-worktree-reopen", "Open worktree", cx => this.retryLaunch(cx), true))))
      .when(Boolean(this.existing) && !this.busy, el => el.child(h_flex().gap(8)
        .child(button("machine-worktree-open-existing", "Open in OMP", () => { openMachineCheckout(this.existing, this.machine); closeOverlay(this.overlay); }, true))
        .child(button("machine-worktree-open-shell", "Open shell", () => { openMachineCheckout(this.existing, this.machine, true); closeOverlay(this.overlay); }))
        .child(button("machine-worktree-run-setup", "Run setup", () => this.runSetup()))
        .child(button("machine-worktree-copy-path", "Copy path", cx => cx.write_to_clipboard(this.existing)))))
      .child(div().text_size(11).text_color(t.muted).child(`${compact ? "" : "↑ ↓ Select   ·   "}${this.reviewed ? "Enter Create worktree" : this.source ? "Enter Review worktree" : "Enter Select"}   ·   Esc Close`));
  }
}
