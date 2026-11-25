// Over9k's help and options (the over9k sidebar reads the options). Options:
// this computer's Chats and Projects, the hand-off rule, what space and agent
// rows show, and whether agent rows are compact (one line) or expanded (the
// name, then its info under it). Saved in shared "sidebar.options" as they
// change. Help: what Over9k adds. Opened from the sidebar footer
// (over9k-footer). Esc closes. The title bar links to the repo, to star it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { FolderPick } from "./folder-pick.js";
import { helpTopics } from "./help.js";
import {
  RELOAD_KEY,
  changedMods,
  focusSnapshot,
  makeReloadRequest,
  parseLocalStatus,
  reloadPlan,
} from "./local-reload.js";
import { props, closeOverlay, openOverlay, theme, shared, setShared, home, appHome, exec, machines, notify, run, focused } from "herdr";
import { getSidebarConfig, updateSidebarConfig, currentSidebarConfig } from "../../config-store.js";
import { flatDestination } from "../../config.js";
import { MachineSettingsController } from "./machine-settings.js";

export const DEFAULTS = { keepUpToDate: false, handoffRule: false, layout: "expanded", model: true, effort: true, context: true, since: true, cache: true, github: true, dirty: true, sync: true, prs: true, stars: true, issues: true,
  subModel: true, subEffort: true, subContext: true, subTime: true };

// Each [key, label, a note under it]; the sample above shows what each looks like.
const AGENT_ITEMS = [
  ["model", "Model"],
  ["effort", "Effort"],
  ["context", "Context used"],
  ["since", "Time since last reply"],
  ["cache", "Expired cache", "Click it to start fresh from a short recap"],
];
// What a Claude subagent's row shows after its task (under its agent).
const SUB_ITEMS = [
  ["subModel", "Model"],
  ["subEffort", "Effort"],
  ["subContext", "Context used"],
  ["subTime", "Running for"],
];
// Options' pages (the navigator on the left).
const PAGES = [["machines", "Machines"], ["spaces", "Space rows"], ["agents", "Agent rows"], ["subs", "Subagent rows"]];
// over9k's handoff.sh as over9k installs it (relative to home): agents run it
// by that path, so it lives outside the mod. Its --rule on|off writes or removes
// the marked hand-off block in ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md and
// ~/.pi/agent/AGENTS.md; only the switch below (or changing a folder while it's
// on) runs it.
const HANDOFF_SCRIPT = ".local/share/over9k/handoff.sh";
// What Hand off project work does (on this computer or another).
const HANDOFF = "Chats outside a project pass project work to a new agent in it. Adds a rule to CLAUDE.md and AGENTS.md";
const RELOAD_TIMEOUT = 60000;

const joinPath = (root, child) => `${String(root ?? "").replace(/[\\/]+$/, "")}/${child}`;
const gitArgs = (checkout, args) => ["-c", "credential.interactive=false", "-C", checkout, ...args];
const resultText = (result) => `${result?.stderr ?? ""}${result?.stdout ?? ""}`.trim();

async function git(checkout, args) {
  const result = await exec("git", gitArgs(checkout, args), { timeout: RELOAD_TIMEOUT }).catch((error) => ({ code: 1, stderr: String(error), stdout: "" }));
  if (result?.code !== 0) throw new Error(resultText(result) || `git ${args.join(" ")} failed`);
  return result.stdout ?? "";
}

async function checkoutRoot() {
  const installed = joinPath(appHome().replace(/\\/g, "/"), "mods/sidebar-overhaul");
  return (await git(installed, ["rev-parse", "--show-toplevel"])).trim();
}

async function validateChangedMods(checkout, files) {
  const mods = changedMods(files);
  const failures = [];
  for (const mod of mods) {
    const path = joinPath(checkout, `over9k/mods/${mod}`);
    const result = await exec("herdr-app", ["check", path], { timeout: RELOAD_TIMEOUT }).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
    if (result?.code !== 0) failures.push({ mod, path, error: resultText(result) || `herdr-app check exited ${result?.code ?? "unknown"}` });
  }
  return { mods, failures };
}
// The setup's wider scan (as the + menu's): git repos up to two levels under
// home, and folders Claude Code has worked in.
const MORE = `{
  find "$HOME" -maxdepth 3 \\( -path "$HOME/.*" -o -name node_modules \\) -prune -o -name .git -print 2>/dev/null | sed 's#/[^/]*$##'
  for d in "$HOME"/.claude/projects/*/; do
    f=$(ls -t "$d"*.jsonl 2>/dev/null | head -n 1); [ -n "$f" ] || continue
    grep -m 1 -o '"cwd":"[^"]*"' "$f" | cut -d '"' -f 4
  done
} | while read -r d; do [ -d "$d" ] && echo "$d"; done | sort -u`;

// Over9k on GitHub, where the title bar's Star on GitHub goes.
const REPO = "https://github.com/herunan/herdr-over9k";
// Each a button on the row: what clicking it does, under its name. Git's from
// the repo itself; GitHub's from GitHub (gh), every 5 minutes.
const SPACE_ITEMS = [
  ["dirty", "Uncommitted files", "Opens Changes"],
  ["sync", "Commits to push or pull", "Click to push (twice) or pull"],
];
const GITHUB_ITEMS = [
  ["github", "GitHub link", "Opens the repo"],
  ["prs", "Pull requests", "Red if your review is wanted"],
  ["issues", "Open issues", "On your repos; opens them"],
  ["stars", "Stars", "On your repos; opens who starred it"],
];

export default class SidebarOptions extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.tab = "options";
    this.page = "machines";
    this.machineSettings = new MachineSettingsController({ config: null, machines: machines() ?? [], home: home(), machine: props()?.computer ?? null });
    this.machineInputs = {};
    this.machineCloseConfirm = false;
    this.machineSaving = false;
    cx.timer.every(500, (cx) => { if (this.dirty) { this.dirty = false; cx.notify(); } });
    this.topic = 0;
    this.setup = Boolean(props()?.setup);
    this.tip = null;
    this.armed = false;
    this.config = null;
    this.configError = null;
    this.reloading = false;
    this.confirming = false;
    this.reloadCandidate = null;
    this.reloadStatus = "";
    this.reloadResult = null;
    this.reloadRequest = null;
    cx.spawn(async (cx) => { await this.loadConfig(); cx.notify(); });
  }

  bootstrapObserved() {
    return {
      home: home(),
      options: { ...DEFAULTS, ...(shared("sidebar.options") ?? {}) },
      locations: shared("over9k.locations"),
      projects: { local: { pinned: shared("projects.pinned"), hidden: shared("projects.hidden"), unpinned: shared("projects.unpinned"), listed: shared("projects.listed") }, remote: shared("projects.on") },
      names: shared("projects.names"),
    };
  }

  async loadConfig() {
    try {
      this.config = await getSidebarConfig(this.bootstrapObserved());
      this.configError = null;
      this.machineSettings.setConfig(this.config.config);
      this.prepareMachineInputs();
    } catch (error) { this.configError = String(error?.message ?? error); }
  }
  prepareMachineInputs() {
    const editor = this.machineSettings;
    editor.setConfig(currentSidebarConfig() ?? this.config?.config ?? null);
    const machine = editor.machine;
    const draft = editor.draft();
    this.machineInputs = Object.fromEntries(["projects", "chats", "worktreeDirectory"].map(key => {
      const input = InputState.new({ value: draft[key], placeholder: "/absolute/path" });
      input.on("change", (_event, cx) => {
        if (this.machineInputs[key] !== input) return;
        editor.set(key, input.value(), machine);
        this.machineNotice = "";
        cx.notify();
      });
      return [key, input];
    }));
  }

  selectMachine(machine, cx) {
    if (this.machineSaving || this.machineSettings.machine === machine) return;
    this.machineSettings.machine = machine;
    this.machineSettings.error = "";
    this.machineFolderPick = null;
    this.machineNotice = "";
    this.prepareMachineInputs();
    cx.notify();
  }

  openMachineFolder(key, cx) {
    const editor = this.machineSettings;
    const machine = editor.machine;
    if (!editor.connected() || this.machineSaving) return;
    const pick = new FolderPick({ value: editor.draft()[key] || "~", machine,
      home: machine == null && key !== "worktreeDirectory" ? home() : null,
      done: (value, cx) => {
        const apply = path => {
          if (this.machineFolderPick?.pick !== pick) return;
          editor.set(key, path, machine);
          this.machineFolderPick = null;
          this.machineNotice = "";
          this.machineInputs[key].set_value(path);
        };
        if (key === "worktreeDirectory" && /^~(?=\/|$)/.test(value)) cx.spawn(async (cx) => {
          try {
            const result = machine == null ? { code: 0, stdout: home() } : await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine });
            if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not resolve the machine’s home folder.");
            apply(value.replace(/^~/, result.stdout.trim()));
          } catch (error) { editor.error = String(error?.message ?? error); }
          cx.notify();
        });
        else apply(value);
      },
    });
    this.machineFolderPick = { key, pick };
    cx.notify();
  }

  requestMachineClose(cx) {
    if (this.machineSaving) return;
    if (!this.machineSettings?.knownMachines().some(machine => this.machineSettings.dirty(machine))) return closeOverlay(props()?.overlay);
    this.machineCloseConfirm = true;
    cx.notify();
  }

  async saveMachineSettings(cx) {
    if (this.machineSaving) return;
    this.machineSaving = true;
    this.machineSettings.error = "";
    cx.notify();
    try {
      const before = { ...this.machineSettings.draft() };
      const changed = this.machineSettings.changed();
      const saved = await this.machineSettings.save({ persist: (mutator) => updateSidebarConfig(mutator, this.bootstrapObserved()), exec, machines: machines() ?? [] });
      if (!saved) return;
      this.config = saved;
      if (this.machineSettings.machine == null && (changed.includes("handoffRule") || (before.handoffRule && changed.some(key => key === "chats" || key === "projects")))) {
        exec("sh", ["-c", '[ -f "$HOME/$2" ] && sh "$HOME/$2" --rule "$1"', "sh", before.handoffRule ? "on" : "off", HANDOFF_SCRIPT]).catch(() => null);
      }
      this.machineCloseConfirm = false;
      this.machineNotice = this.machineSettings.connected() ? "Saved" : "Saved without checking paths (offline)";
      this.prepareMachineInputs();
      this.machineFolderPick = null;
    } catch (error) {
      this.machineSettings.error = String(error?.message ?? error);
    } finally {
      this.machineSaving = false;
      cx.notify();
    }
  }

  machineSettingsPage(t, cx) {
    if (!this.machineInputs?.projects) return div().text_color(this.configError ? t.blocked : t.muted).child(this.configError || "Loading machine settings…");
    const editor = this.machineSettings;
    editor.setMachines(machines() ?? []);
    const machine = editor.machine, online = editor.connected(), draft = editor.draft(), dirty = editor.dirty(), saving = this.machineSaving;
    const label = name => name ?? "This computer";
    const heading = text => div().font_semibold().text_size(15).child(text);
    const note = text => div().text_size(11).text_color(t.muted).child(text);
    const button = (id, text, action, disabled = false, primary = false) => h_flex().id(id).h(28).px(10).flex_none().items_center().rounded(6)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(disabled, el => el.opacity(0.5)).when(!disabled, el => el.cursor_pointer().hover(s => s.opacity(0.85)).on_click((_e, cx) => action(cx))).child(text);
    const field = (key, title, description) => v_flex().flex_none().gap(3)
      .child(div().font_medium().child(title)).child(note(description))
      .child(h_flex().items_center().gap(6)
        .child(saving ? div().flex_1().child(draft[key]) : Input.new(this.machineInputs[key]).h(30).px(8).flex_1().min_w(0).rounded(6).border_1().border_color(t.input).bg(t.background))
        .child(button(`machine-${key}-browse`, this.machineFolderPick?.key === key ? "Cancel" : "Browse…", cx => {
          if (this.machineFolderPick?.key === key) { this.machineFolderPick = null; cx.notify(); }
          else this.openMachineFolder(key, cx);
        }, !online || saving)))
      .when(online && !saving && this.machineFolderPick?.key === key, el => el.child(this.machineFolderPick.pick.view(t, cx)));
    const check = (key, title, description) => h_flex().id(`machine-${key}`).min_h(34).px(4).gap(8).items_center().rounded(6)
      .when(!saving, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => { editor.set(key, !editor.draft()[key]); this.machineNotice = ""; cx.notify(); }))
      .child(h_flex().size(16).flex_none().rounded(4).items_center().justify_center().border_1().border_color(draft[key] ? t.accent : t.input).bg(draft[key] ? t.accent : t.background)
        .when(draft[key], el => el.child(svg("mods/workspace-chrome/check.svg").size(11).text_color(t.accent_foreground))))
      .child(v_flex().flex_1().min_w(0).child(div().child(title)).child(note(description)));
    let example = "Enter an absolute folder to preview the checkout path.";
    try { example = flatDestination(draft.worktreeDirectory.trim(), "Reaparr", "feature/login"); } catch {}
    const tabs = this.setup ? [null] : editor.knownMachines();
    const tab = name => h_flex().id(`machine-tab-${name ?? "local"}`).h(30).px(9).gap(6).flex_none().items_center().rounded(6)
      .border_1().border_color(machine === name ? t.accent : t.border).bg(machine === name ? t.raised : t.background)
      .when(!saving, el => el.cursor_pointer().on_click((_e, cx) => this.selectMachine(name, cx)))
      .child(div().size(6).rounded(3).bg(editor.connected(name) ? t.ansi2 : t.dim)).child(label(name))
      .when(editor.dirty(name), el => el.child(div().text_color(t.ansi3).child("•")));
    return v_flex().id("machine-settings").flex_none().gap(10)
      .child(h_flex().id("machine-tabs").min_w(0).overflow_x_scrollbar().gap(5).children(tabs.map(tab)))
      .child(h_flex().items_center().gap(8).child(heading("Folders"))
        .when(!online, el => el.child(div().text_size(11).text_color(t.ansi3).child("Offline"))))
      .when(!online, el => el.child(div().id("machine-offline-notice").child(note("You can save absolute paths offline. Browse and path checks need a connection."))))
      .child(field("projects", "Projects folder", "Where Add Spaces browses and looks for projects."))
      .child(field("chats", "New chat folder", "Where chats outside a project start."))
      .child(field("worktreeDirectory", "New worktree folder", "Where Git creates new checkouts. Existing worktrees stay put."))
      .child(v_flex().pt(8).gap(5).border_t_1().border_color(t.border)
        .child(heading("Workspace creation"))
        .child(v_flex().gap(2).p(7).rounded(6).bg(t.background).child(note("Example checkout for Reaparr · feature/login"))
          .child(div().id("machine-destination-preview").child(example)))
        .child(note("New spaces start OMP by default."))
        .child(check("keepUpToDate", "Add new projects automatically", "Off keeps manual Add Spaces and Scan available."))
        .child(check("handoffRule", "Hand off project work", HANDOFF))
        .child(h_flex().gap(8).items_center()
          .child(button("machine-hook-settings", "Worktree hooks…", () => openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 640, height: 620, props: { view: "worktree-settings", machine } }), saving))
          .child(note("Setup commands by repository."))))
      .when(!this.setup && machine == null, el => el.child(h_flex().child(button("run-setup", "Run setup again", cx => { this.setup = true; cx.notify(); }, saving))));
  }


  machineFooter(t) {
    const editor = this.machineSettings;
    const dirty = editor.dirty(), saving = this.machineSaving;
    const button = (id, text, action, disabled, primary = false) => h_flex().id(id).h(28).px(10).flex_none().items_center().rounded(6)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(disabled, el => el.opacity(0.5)).when(!disabled, el => el.cursor_pointer().hover(s => s.opacity(0.85)).on_click((_e, cx) => action(cx))).child(text);
    return v_flex().flex_none().pt(8).mt(6).gap(4).border_t_1().border_color(t.border)
      .when(Boolean(editor.error), el => el.child(div().id("machine-settings-error").text_color(t.blocked).child(editor.error)))
      .child(h_flex().gap(7).items_center()
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(dirty ? `Unsaved changes · ${editor.machine ?? "This computer"}` : this.machineNotice || `Settings for ${editor.machine ?? "This computer"}`))
        .when(dirty, el => el.child(button("machine-discard", "Discard", cx => {
          editor.discard(); this.machineFolderPick = null; this.machineNotice = ""; this.prepareMachineInputs(); cx.notify();
        }, saving)))
        .child(button("machine-close", this.setup ? "Done" : "Close", cx => this.requestMachineClose(cx), saving))
        .child(button("machine-save", saving ? "Saving…" : "Save", cx => cx.spawn(cx => this.saveMachineSettings(cx)), !dirty || saving, true)));
  }

  persist(mutator) {
    return updateSidebarConfig(mutator, this.bootstrapObserved()).then((result) => {
      this.config = result;
      return result;
    }).catch((error) => {
      this.configError = String(error?.message ?? error);
      return null;
    });
  }

  set(key, value) {
    this.persist((config) => { config.options[key] = value; return config; });
    setShared("sidebar.options", { ...DEFAULTS, ...(shared("sidebar.options") ?? {}), [key]: value });
  }

  // One page (PAGES): a heading and a line on what it's for, then its settings.
  // Setup mode: Folders, then the spaces to pin.
  options(t, o, cx) {
    const group = (title, about, first) => v_flex().flex_none().pt(first ? 0 : 24).pb(10).gap(3)
      .child(div().text_size(16).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(about), (el) => el.child(div().text_size(12).text_color(t.dim).child(about ?? "")));
    const choice = (id, text, on) => h_flex().id(id).flex_1().h(30).items_center().justify_center().rounded(7).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent + "26" : t.raised).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click(() => this.set("layout", id)).child(text);
    // A note beneath the label (under) when it needs one.
    const check = ([key, text, under]) => h_flex().id(`show-${key}`).min_h(30).py(5).px(4).gap(10).items_center().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => this.set(key, !o[key]))
      .child(h_flex().size(16).flex_none().rounded(4).items_center().justify_center()
        .border_1().border_color(o[key] ? t.accent : t.input).bg(o[key] ? t.accent : t.background)
        .when(o[key], (el) => el.child(svg("mods/workspace-chrome/check.svg").size(11).text_color(t.accent_foreground))))
      .child(v_flex().flex_1().min_w(0).child(div().text_color(t.foreground).child(text))
        .when(Boolean(under), (el) => el.child(div().text_size(11).text_color(t.dim).child(under ?? ""))));
    if (this.setup) return v_flex().gap(16).child(this.machineSettingsPage(t, cx)).child(this.spacesGroup(t, group, cx));
    if (this.page === "machines") return this.machineSettingsPage(t, cx);
    return this.viewPage(t, o, group, check, choice);
  }

  // Setup's Spaces: everything found (and pinned), each with Pin / Pinned as in
  // the + menu's lists; Pin all; Automatically scan for spaces adds the wider scan.
  spacesGroup(t, group, cx) {
    const configured = this.config?.config?.machines?.local?.projects ?? {};
    const pinned = new Set((configured.pinned ?? shared("projects.pinned") ?? []).map((entry) => typeof entry === "string" ? entry : entry.path ?? entry.repo));
    const found = [...new Set([...(shared("projects.auto") ?? []), ...pinned, ...(this.more ?? [])])]
      .sort((a, b) => a.split("/").pop().localeCompare(b.split("/").pop(), undefined, { sensitivity: "base" }));
    const pin = (dirs, on) => {
      const p = new Set(pinned), u = new Set((configured.unpinned ?? shared("projects.unpinned") ?? []).map((entry) => typeof entry === "string" ? entry : entry.path ?? entry.repo));
      dirs.forEach((d) => { if (on) { p.add(d); u.delete(d); } else { p.delete(d); u.add(d); } });
      this.persist((config) => { config.machines.local.projects.pinned = [...p]; config.machines.local.projects.unpinned = [...u]; return config; });
      setShared("projects.pinned", [...p]);
      setShared("projects.unpinned", [...u]);
    };
    const button = (id, text, on, fn) => h_flex().id(id).h(20).px(6).flex_none().rounded(5).items_center().cursor_pointer()
      .border(1).border_color(t.border).text_size(11).text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { fn(); cx.notify(); }).child(text);
    const all = found.length > 0 && found.every((d) => pinned.has(d));
    return v_flex().flex_none()
      .child(group("Spaces", "Pinned ones stay in the sidebar."))
      .child(h_flex().px(4).pb(4).justify_end().child(button("pin-all", "Pin all", all, () => pin(found, true))))
      .child(div().id("spaces-wrap").flex_none().on_scroll_wheel((_e, cx) => cx.stop_propagation()).child(
        v_flex().id("spaces-list").h(200).flex_none().overflow_y_scrollbar().rounded(8).border_1().border_color(t.border).p(4)
          .children(found.map((d) => h_flex().id(`sp-${d}`).h(28).px(6).gap(10).items_center().rounded(6)
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(d.split("/").pop()))
            .child(div().flex_none().text_size(11).text_color(t.dim).child((d.startsWith(home() + "/") ? `~${d.slice(home().length)}` : d).split("/").slice(0, -1).join("/")))
            .child(button(`pin-${d}`, pinned.has(d) ? "Pinned" : "Pin", pinned.has(d), () => pin([d], !pinned.has(d))))))))
      .child(h_flex().id("scan-more").mt(6).h(30).px(4).gap(10).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.scanMore(cx))
        .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.foreground))
        .child(div().flex_1().text_color(t.foreground).child("Find more in your home folder"))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.scanning ? "Scanning\u2026" : this.more?.length ? `${this.more.length} found` : "")));
  }

  // Wider than the sidebar's own: git repos up to two levels under home and
  // folders Claude Code has worked in (the + menu's scan does the same).
  scanMore(cx) {
    this.scanning = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", MORE]).catch(() => null);
      this.more = (r?.stdout ?? "").split("\n").filter((d) => d && d !== home() && !d.startsWith("/tmp/"));
      this.scanning = false;
      cx.notify();
    });
  }

  // Space rows, Agent rows or Subagent rows: heading, sample, then what it shows.
  viewPage(t, o, group, check, choice) {
    const page = v_flex().flex_none();
    if (this.page === "spaces") return page
      .child(group("Space rows", "Shown next to the name. All clickable.", true))
      .child(this.sample(t, this.spaceSample(t, o)))
      .child(group("Git", "From the repo on this computer.", false))
      .children(SPACE_ITEMS.map(check))
      .child(group("GitHub", "For repos on GitHub. Counts need gh, signed in; checked every 5 minutes.", false))
      .children(GITHUB_ITEMS.map(check));
    if (this.page === "agents") return page
      .child(group("Agent rows", "Compact: one line. Expanded: details below the name (always, in Agents › Status).", true))
      .child(h_flex().gap(8).pb(8)
        .child(choice("compact", "Compact", o.layout === "compact"))
        .child(choice("expanded", "Expanded", o.layout === "expanded")))
      .child(this.sample(t, this.agentSample(t, o)))
      .children(AGENT_ITEMS.map(check));
    return page
      .child(group("Subagent rows", "Claude Code's subagents, listed under their agent.", true))
      .child(this.sample(t, this.agentSample(t, o, true)))
      .children(SUB_ITEMS.map(check));
  }




  // A made-up row drawn like the sidebar's (same sizes and gaps), showing what
  // the switches do: off parts are hidden, as there. Hovering and clicking act
  // as there too (hover text on the right, the push button asking twice, the ×,
  // "clear + recap"), only nothing really happens.
  sample(t, row) {
    return v_flex().flex_none().mb(6).rounded(8).bg(t.chrome).border_1().border_color(t.border).text_size(13).child(row);
  }

  // A part of the space sample: its hover text shows on the row's right; a
  // click shows what it would do (`then`, or the hover text again).
  part(t, key, el, text, then) {
    return el.id(`sample-${key}`).rounded(4).hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.tip = text; else if (this.tip === text) this.tip = null; cx.notify(); })
      .on_click((_e, cx) => { this.tip = then ? then() : text; cx.notify(); });
  }

  spaceSample(t, o) {
    const tip = this.tip && !this.tip.startsWith("agent:") ? this.tip : null;
    const on = this.spaceHover;
    return v_flex().id("sample-space").px(8).h(30).justify_center().rounded(8).hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { this.spaceHover = h; cx.notify(); })
      .child(h_flex().gap(9).items_center()
        .child(div().flex_none().text_color("#5b8def").child("my-project"))
        .when(o.github, (el) => el.child(this.part(t, "github", div().flex_none().ml(-5).p(2).text_color(t.dim).hover((s) => s.text_color(t.foreground)).child(svg("mods/sidebar-overhaul/github.svg").size(13)), "Open in GitHub")))
        .child(h_flex().flex_none().gap(3).items_center().text_size(11.5)
          .when(o.dirty, (el) => el.child(this.part(t, "dirty", div().px(2).text_color(t.ansi3).child("4"), "See 4 uncommitted files")))
          .when(o.sync, (el) => el
            .child(this.part(t, "ahead", div().px(2).text_color(t.ansi2).when(this.armed, (e) => e.bg(t.hover)).child("\u21912"),
              this.armed ? "Click again to push" : "Push 2 commits",
              () => { this.armed = !this.armed; return this.armed ? "Click again to push" : "Pushed 2 commits"; }))
            .child(this.part(t, "behind", div().px(2).text_color(t.ansi1).child("\u21931"), "Pull 1 new commit")))
          .when(o.prs, (el) => el.child(this.part(t, "prs", h_flex().px(2).gap(2).items_center().text_color(t.dim).child(svg("mods/sidebar-overhaul/pull-request.svg").size(11)).child("3"), "Open 3 pull requests")))
          .when(o.issues, (el) => el.child(this.part(t, "issues", h_flex().px(2).gap(2).items_center().text_color(t.dim).child(svg("mods/sidebar-overhaul/issue.svg").size(11)).child("2"), "Open 2 issues")))
          .when(o.stars, (el) => el.child(this.part(t, "stars", h_flex().px(2).gap(2).items_center().text_color(t.dim).child(svg("mods/sidebar-overhaul/star.svg").size(11)).child("8"), "8 stars on GitHub"))))
        // As there: the fold chevron and (FOLD), the hover text or folder, the + (ADD).
        .child(h_flex().w(16).flex_none().items_center().justify_center().text_color(t.dim)
          .child(svg("mods/workspace-chrome/chevron-down.svg").size(10).opacity(on ? 1 : 0)))
        .child(h_flex().flex_1().min_w(0).justify_end().items_center().text_size(11).text_color(t.dim)
          .when(Boolean(tip ?? on), (el) => el.child(div().min_w(0).truncate().child(tip ?? "~/Code/my-project"))))
        .child(h_flex().w(22).flex_none().justify_center()
          .when(Boolean(on), (el) => el.child(h_flex().size(18).items_center().justify_center().rounded(5).text_color(t.dim)
            .child(svg("mods/workspace-chrome/plus.svg").size(12))))));
  }

  // As the sidebar draws an agent now: its details dotted, then the link chip
  // (it works on another computer too) and the count chip (in compact, just the
  // total); under it, what it started on a line, each with its kind on it.
  // `subs`: the agent with two subagents, for Subagent rows.
  agentSample(t, o, subs = false) {
    const compact = o.layout === "compact";
    const hover = this.tip === "agent:row" || this.tip === "agent:exp";
    const dotted = (parts) => parts.flatMap((el, n) => (n ? [div().px(1).child("\u00b7"), el] : [el]));
    const info = h_flex().flex_none().items_center().text_size(11).text_color(t.dim)
      .children(dotted([
        o.model && div().child("Opus 5.5"),
        o.effort && div().child("high"),
        o.context && div().text_color(t.ansi2).child("42%"),
        o.since && div().child("3m"),
      ].filter(Boolean)))
      .when(o.cache, (el) => el.child(div().id("sample-exp").ml(4).px(2).rounded(4).text_color(t.ansi1).hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => { this.tip = on ? "agent:exp" : "agent:row"; cx.notify(); })
        .child(this.tip === "agent:exp" ? "clear + recap" : "exp.")));
    const link = "#8b7cf6", fg = t.foreground, wash = (a) => (/^#[0-9a-f]{6}$/i.test(fg) ? fg + a : t.raised);
    const chips = h_flex().flex_none().gap(5).items_center()
      .child(h_flex().h(16).px(4).gap(3).items_center().rounded(4).bg(link + "26").text_size(10.5).text_color(link)
        .child(svg("mods/sidebar-overhaul/bot.svg").size(10)).child("\u2192"))
      .child(h_flex().h(16).px(4).gap(3).items_center().rounded(4).bg(wash(hover ? "29" : "1a")).text_size(10.5).text_color(fg)
        .when(compact, (el) => el.child("3"))
        .when(!compact, (el) => el.child(svg("mods/sidebar-overhaul/subagent.svg").size(10)).child("1")
          .child(svg("mods/sidebar-overhaul/cpu.svg").size(10).ml(3)).child("1").child(svg("mods/sidebar-overhaul/clock.svg").size(10).ml(3)).child("1"))
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(8)));
    const name = div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).when(!compact, (el) => el.line_height("15px")).child("Fix the login bug");
    const agent = h_flex().id("sample-agent").h(compact ? 26 : 36).pl(4).pr(8).gap(8).items_center().rounded(7).hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.tip = this.tip === "agent:exp" ? this.tip : "agent:row"; else if (this.tip?.startsWith("agent:")) this.tip = null; cx.notify(); })
      .child(h_flex().flex_none().gap(4).items_center()
        .child(h_flex().w(16).flex_none().justify_center()
          .when(hover, (el) => el.child(h_flex().size(16).items_center().justify_center().rounded(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .child(svg("mods/pane/close.svg").size(11))))
          .when(!hover, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900))))
        .child(image("icons/claude.svg").w(14).h(14).flex_none()))
      // As there: compact, the chips end the details' line; expanded, they end
      // the name's line, the details under it.
      .when(compact, (el) => el.child(v_flex().flex_1().min_w(0).child(h_flex().min_w(0).gap(6).items_center().child(name)))
        .child(info.child(chips.ml(5))))
      .when(!compact, (el) => el.child(v_flex().flex_1().min_w(0).overflow_hidden()
        .child(h_flex().min_w(0).gap(6).items_center().child(name).child(div().flex_1()).child(chips))
        .child(info.line_height("13px"))));
    // A sub-row: status, its kind on the line (the last one's line ends there), name, details.
    const sub = (icon, logo, text, details, last, spin) => h_flex().h(22).pl(10).pr(8).gap(3).items_center().text_size(12)
      .child(h_flex().w(12).pt(2).flex_none().justify_center().when(spin, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(900))))
      .child(v_flex().w(12).h(22).flex_none().items_center()
        .child(div().w(1.5).h(icon.endsWith("subagent.svg") ? 5 : 6).flex_none().bg(t.input))
        .child(svg(icon).size(icon.endsWith("subagent.svg") ? 12 : 9).flex_none().my(1).text_color(t.dim))
        .child(div().w(1.5).flex_1().when(!last, (el) => el.bg(t.input))))
      .when(Boolean(logo), (el) => el.child(image(logo).w(13).h(13).flex_none()))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().line_height("15px").text_color(t.muted).child(text)))
        .child(h_flex().flex_none().items_center().text_size(11).text_color(t.dim).children(dotted(details.map((d) => div().child(d))))));
    // A subagent's details, as Subagent rows says: model, effort, its type when
    // not the usual one, context, running for.
    const subFacts = (model, effort, type, k, ran) => [o.subModel && model, o.subEffort && effort, type, o.subContext && k, o.subTime && ran].filter(Boolean);
    if (subs) return v_flex().flex_none()
      .child(agent)
      .child(sub("mods/sidebar-overhaul/subagent.svg", "icons/claude.svg", "Read the auth code", subFacts("Haiku 5.5", "low", "explore", "18k", "2m"), false, true))
      .child(sub("mods/sidebar-overhaul/subagent.svg", "icons/claude.svg", "Write the tests", subFacts("Sonnet 5.5", "med", null, "98k", "13m"), true, true));
    return v_flex().flex_none()
      .child(agent)
      .child(sub("mods/sidebar-overhaul/subagent.svg", "icons/claude.svg", "Read the auth code", subFacts("Haiku 5.5", "low", "explore", "18k", "2m"), false, true))
      .child(sub("mods/sidebar-overhaul/cpu.svg", null, "npm run dev", ["shell", "5m"], false, false))
      .child(sub("mods/sidebar-overhaul/clock.svg", null, "Check the deploy", ["every 1h at :07"], true, false));
  }


  // Help: a picture of each thing Over9k adds, and how to use it (help.js).
  // The left column: Options' pages, or Help's pages under their parts. The
  // picked one is highlighted.
  nav(t) {
    const item = (id, text, on, pick) => h_flex().id(`nav-${id}`).h(28).px(10).items_center().rounded(7).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.raised).font_medium()).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { pick(); cx.notify(); }).child(div().truncate().child(text));
    const head = (text) => div().px(10).pt(12).pb(4).text_size(10.5).text_color(t.dim).child(text.toUpperCase());
    const col = v_flex().id("nav").w(176).flex_none().h_full().overflow_y_scrollbar().pr(10).border_r_1().border_color(t.border);
    if (this.tab !== "help") return col.children(PAGES.map(([id, text]) => item(id, text, this.page === id, () => { this.page = id; })));
    const topics = helpTopics(this, theme());
    return col.children(topics.flatMap((x, i) => [...(i === 0 || topics[i - 1].part !== x.part ? [head(x.part)] : []),
      item(`help-${i}`, x.title, this.topic === i, () => { this.topic = i; })]));
  }

  // One Help page: its part and title, the page, then Previous and Next.
  help(t) {
    const topics = helpTopics(this, t), i = Math.min(this.topic, topics.length - 1), x = topics[i];
    const step = (id, label, to) => h_flex().id(id).h(28).px(10).gap(6).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(t.input).text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.topic = to; cx.notify(); }).child(label);
    return v_flex().flex_none().gap(14)
      .child(v_flex().gap(3)
        .child(div().text_size(10.5).text_color(t.dim).child(x.part.toUpperCase()))
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(x.title)))
      .child(x.el)
      .child(h_flex().pt(10).gap(8)
        .when(i > 0, (el) => el.child(step("help-prev", `\u2190 ${topics[i - 1].title}`, i - 1)))
        .child(div().flex_1())
        .when(i < topics.length - 1, (el) => el.child(step("help-next", `${topics[i + 1].title} \u2192`, i + 1))));
  }

  // The options as they are now (help.js draws its samples with them).
  opts() {
    return { ...DEFAULTS, ...(shared("sidebar.options") ?? {}) };
  }

  syncReloadAck() {
    const pending = this.reloadRequest;
    const ack = shared(RELOAD_KEY);
    if (!pending || !ack || pending.requestId !== ack.requestId || !["acknowledged", "failed"].includes(ack.status)) return;
    if (this.reloadRequest.status === ack.status) return;
    this.reloadRequest = { ...pending, ...ack };
    this.confirming = false;
    this.reloadStatus = ack.status === "acknowledged" ? "reloaded" : "failed";
    this.reloadResult = ack.status === "acknowledged"
      ? { message: "Checked Over9k mods are active again; terminals kept running." }
      : { error: String(ack.error ?? "The sidebar did not acknowledge the reload.") };
    this.dirty = true;
  }

  beginReload(cx) {
    if (this.reloading || this.reloadStatus === "reloading") return;
    this.confirming = false;
    this.reloadCandidate = null;
    this.reloadStatus = "checking";
    this.reloadResult = null;
    this.reloading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const checkout = await checkoutRoot();
        const rawStatus = await git(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]);
        const localStatus = parseLocalStatus(rawStatus);
        const validation = await validateChangedMods(checkout, localStatus.paths.join("\n"));
        if (!validation.mods.length) throw new Error("No changed Over9k mods were found; edit a mod and check again.");
        if (validation.failures.length) {
          const details = validation.failures.map((failure) => `${failure.mod}: ${failure.error}`).join("\n");
          throw new Error(`The changed mods were not activated; the running instance was kept. ${details}`);
        }
        const layoutName = shared("layout");
        if (!layoutName) throw new Error("The current layout is unavailable; the running instance was kept.");
        const checked = Date.now();
        const candidate = {
          affected: validation.mods,
          layoutName,
          localFingerprint: localStatus.fingerprint,
          checked,
        };
        this.reloadCandidate = candidate;
        this.confirming = true;
        this.reloadStatus = "ready";
        this.reloadResult = { checkedMods: validation.mods, checked };
      } catch (error) {
        const message = String(error?.message ?? error ?? "The local mods could not be checked.");
        this.confirming = false;
        this.reloadCandidate = null;
        this.reloadStatus = "failed";
        this.reloadResult = { error: message };
        notify({ title: "Over9k local reload was not prepared", body: message, level: "error" });
      } finally {
        this.reloading = false;
        cx.notify();
      }
    });
  }

  reloadCurrent(cx) {
    const candidate = this.reloadCandidate;
    if (!candidate?.affected?.length || this.reloading || this.reloadStatus === "reloading") return;
    this.confirming = false;
    this.reloading = true;
    this.reloadStatus = "reloading";
    this.reloadResult = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let request = null;
      try {
        const checkout = await checkoutRoot();
        const rawStatus = await git(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]);
        const localStatus = parseLocalStatus(rawStatus);
        if (localStatus.fingerprint !== candidate.localFingerprint) {
          throw new Error("Local mod files changed after the check; check them again before reloading.");
        }
        const validation = await validateChangedMods(checkout, localStatus.paths.join("\n"));
        if (validation.failures.length) {
          const details = validation.failures.map((failure) => `${failure.mod}: ${failure.error}`).join("\n");
          throw new Error(`The changed mods were not activated; the running instance was kept. ${details}`);
        }
        if (JSON.stringify(validation.mods) !== JSON.stringify(candidate.affected)) {
          throw new Error("The checked mods changed; check them again before reloading.");
        }
        const savedFocus = focusSnapshot(focused());
        const plan = reloadPlan({
          layoutName: candidate.layoutName ?? shared("layout"),
          focus: savedFocus,
          affectedMods: validation.mods,
        });
        if (!plan.ok) throw new Error(plan.error);
        request = makeReloadRequest({
          requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          layoutName: plan.layoutName,
          focus: savedFocus,
          affectedMods: validation.mods,
        });
        this.reloadRequest = request;
        setShared(RELOAD_KEY, request);
        this.reloadResult = {
          message: "Reload requested; waiting for the sidebar to acknowledge it.",
          warning: plan.warning,
          checkedMods: validation.mods,
        };
        plan.commands.forEach((command) => run(command.name, command.args));
      } catch (error) {
        const message = String(error?.message ?? error ?? "The local mods were not reloaded.");
        if (request) setShared(RELOAD_KEY, { ...request, status: "failed", error: message, failedAt: Date.now() });
        this.reloadStatus = "failed";
        this.reloadResult = { error: message };
        notify({ title: "Over9k local reload failed", body: message, level: "error" });
      } finally {
        this.reloadCandidate = null;
        this.reloading = false;
        cx.notify();
      }
    });
  }

  reloadControl(t, cx) {
    const busy = this.reloading || this.reloadStatus === "reloading";
    const label = this.reloadStatus === "checking" ? "Checking\u2026"
      : this.reloadStatus === "reloading" ? "Reloading\u2026"
        : this.reloadStatus === "reloaded" ? "Reloaded"
          : "Reload local mods";
    const resultMessage = this.reloadResult?.error ?? this.reloadResult?.message;
    const resultTone = this.reloadResult?.error ? t.ansi1 : t.ansi2;
    const action = h_flex().id("local-reload").h(26).px(10).flex_none().items_center().rounded(7).cursor_pointer()
      .border_1().border_color(t.input).text_color(t.muted)
      .when(busy, (el) => el.opacity(0.7))
      .when(!busy, (el) => el.hover((s) => s.text_color(t.foreground)).on_click((_e, clickCx) => this.beginReload(clickCx)))
      .child(label);
    return v_flex().id("local-reload-panel").flex_none().mt(8).gap(4).p(8).rounded(8).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).font_medium().child("Local mod reload"))
        .child(action))
      .when(this.reloadStatus === "ready" && this.reloadCandidate, (el) => el.child(div().text_size(11.5).text_color(t.dim)
        .child(`Checked: ${this.reloadCandidate.affected.join(", ")}`)))
      .when(this.confirming, (el) => el.child(v_flex().id("reload-consent").mt(2).p(8).gap(6).rounded(7).border_1().border_color(t.ansi1 + "88").bg(t.ansi1 + "14")
        .child(div().text_color(t.foreground).font_medium().child("Confirm local reload"))
        .child(div().text_color(t.ansi1).child("Checked local mods will be recreated. Floating windows and mod session state reset; running terminals keep going."))
        .child(h_flex().gap(8).justify_end()
          .child(h_flex().id("reload-cancel").h(26).px(10).items_center().rounded(6).cursor_pointer().border_1().border_color(t.input).text_color(t.muted)
            .on_click((_e, clickCx) => { this.confirming = false; this.reloadCandidate = null; this.reloadStatus = ""; clickCx.notify(); }).child("Cancel"))
          .child(h_flex().id("reload-confirm").h(26).px(10).items_center().rounded(6).cursor_pointer().bg(t.solid).text_color(t.solid_foreground)
            .when(!busy, (el) => el.on_click((_e, clickCx) => this.reloadCurrent(clickCx)))
            .child("Reload checked mods")))))
      .when(Boolean(resultMessage) && !this.confirming, (el) => el.child(div().text_size(11.5).text_color(resultTone).child(resultMessage)));
  }

  machineClosePrompt(t) {
    const editor = this.machineSettings;
    const names = editor.knownMachines().filter(name => editor.dirty(name)).map(name => name ?? "This computer");
    const action = (id, text, click) => h_flex().id(id).h(28).px(9).items_center().rounded(6).bg(t.raised).cursor_pointer().on_click(click).child(text);
    return v_flex().id("machine-close-confirm").mt(9).gap(6).p(9).rounded(6).border_1().border_color(t.ansi3)
      .child(div().font_semibold().child("Discard unsaved machine settings?"))
      .child(div().text_color(t.muted).child(names.join(", ")))
      .child(h_flex().justify_end().gap(7)
        .child(action("machine-close-cancel", "Keep editing", (_e, cx) => { this.machineCloseConfirm = false; cx.notify(); }))
        .child(action("machine-close-discard", "Discard and close", () => closeOverlay(props()?.overlay))));
  }

  render(cx) {
    this.syncReloadAck();
    const t = theme();
    const o = { ...DEFAULTS, ...(this.config?.config?.options ?? {}) };
    const tab = (id, text) => div().id(`tab-${id}`).px(10).h(26).flex().items_center().rounded(6).cursor_pointer()
      .text_color(this.tab === id ? t.foreground : t.dim).when(this.tab === id, (el) => el.bg(t.raised))
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(text);
    return v_flex().id("over9k-options").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        if (this.machineCloseConfirm) { this.machineCloseConfirm = false; cx.notify(); }
        else this.requestMachineClose(cx);
      })
      .size_full().min_h(0).p(18).bg(t.popover).text_size(12.8).text_color(t.foreground)
      // Setup mode (first run, or Run setup again): its own title, no tabs, a Done button.
      .child(h_flex().items_center().gap(8)
        .child(div().text_size(15).font_semibold().child(this.setup ? "Set up Over9k" : "Over9k"))
        .child(h_flex().flex_1().gap(2).pl(8).when(!this.setup, (el) => el.child(tab("options", "Options")).child(tab("help", "Help"))))
        .when(!this.setup, (el) => el.child(h_flex().id("star-github").h(24).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
          .text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => cx.open_url(REPO))
          .child(svg("mods/sidebar-overhaul/star.svg").size(12).flex_none()).child("Star on GitHub")))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(!this.setup, (el) => el.child(this.reloadControl(t, cx)))
      .when(this.machineCloseConfirm, el => el.child(this.machineClosePrompt(t)))
      // The navigator (not in setup), then the page, which scrolls when it's long.
      .child(h_flex().flex_1().min_h(0).pt(14).gap(18).items_start()
        .when(!this.setup, (el) => el.child(this.nav(t)))
        .child(v_flex().id(`body-${this.tab}-${this.tab === "help" ? this.topic : this.page}`).flex_1().min_w(0).h_full().overflow_y_scrollbar()
          .child(div().pr(14).pb(8).child(this.tab === "help" ? this.help(t) : this.options(t, o, cx)))))
      .when(this.tab === "options" && this.page === "machines" && Boolean(this.machineInputs?.projects), el => el.child(this.machineFooter(t)));
  }
}
