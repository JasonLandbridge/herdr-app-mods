import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Scrollbar } from "gpui-base";
import { appHome, closeOverlay, exec, hc, machines, props, readTextFile, run, terminals, theme, writeTextFile } from "herdr";
import { currentSidebarConfig } from "../../config-store.js";
import {
  CONFIG_VERSION,
  WORKTREE_LABELS,
  availabilityChecks,
  commandFieldKey,
  normalizeRoot,
  parseArgvText,
  parseConfig,
  retryGuard,
  saveConfig,
  selectSetupResult,
  updateCommandField,
  validateConfig,
} from "./settings.js";

const emptyConfig = () => ({ version: CONFIG_VERSION, projects: [] });
const emptyProject = () => ({ machine: null, repo: "", hooks: { on_created: [] } });

function formFor(project) {
  const commands = Array.isArray(project?.hooks?.on_created) ? project.hooks.on_created : [];
  return {
    machine: project?.machine == null ? "" : String(project.machine),
    repo: typeof project?.repo === "string" ? project.repo : "",
    commands: commands.map((command) => ({
      name: typeof command?.name === "string" ? command.name : "",
      argv: JSON.stringify(Array.isArray(command?.argv) ? command.argv : []),
      timeout: command?.timeout_seconds == null ? "" : String(command.timeout_seconds),
    })),
  };
}

function labelMap(term) {
  return term?.labels && typeof term.labels === "object" ? term.labels : {};
}

function terminalBelongsToMachine(term, machine) {
  if (term?.machine !== undefined) return (term.machine ?? null) === (machine ?? null);
  const address = String(term?.address ?? "");
  return machine == null ? !address.includes("/") : address.startsWith(`${machine}/`);
}

function rowTime(term) {
  return Number(term?.created_ms ?? 0) || 0;
}

export default class WorktreeHookSettings extends View {
  init(_props, cx) {
    this.path = `${appHome()}/worktree-hooks.json`;
    const opening = props() ?? {};
    this.machine = Object.hasOwn(opening, "machine") ? opening.machine ?? null : undefined;
    this.config = emptyConfig();
    this.forms = [];
    this.form = null;
    this.inputs = {};
    this.selected = -1;
    this.snapshot = null;
    this.errors = [];
    this.error = "";
    this.notice = "";
    this.availability = null;
    this.checking = false;
    this.loading = true;
    this.invalidSource = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => this.load(cx));

  }
  close() {
    closeOverlay(props()?.overlay);
  }

  key(event, cx) {
    if (event.key === "escape") {
      this.close();
      cx.stop_propagation();
    }
  }

  knownMachines() {
    try {
      const names = new Set([null, ...(machines() ?? []).map(entry => entry?.name ?? null)]);
      if (this.machine !== undefined) names.add(this.machine);
      for (const name of Object.keys(currentSidebarConfig()?.machines ?? {})) if (name !== "local") names.add(name);
      return [...names].map(name => ({ name }));
    } catch {
      return undefined;
    }
  }

  async load(cx) {
    this.loading = true;
    this.errors = [];
    this.error = "";
    this.notice = "";
    cx.notify();
    let text;
    try {
      text = await readTextFile(this.path);
    } catch (error) {
      this.snapshot = null;
      this.config = emptyConfig();
      this.forms = [];
      this.form = null;
      this.selected = -1;
      this.invalidSource = true;
      this.error = `Could not read worktree-hooks.json: ${String(error?.message ?? error)}`;
      this.loading = false;
      cx.notify();
      return;
    }
    const parsed = parseConfig(text, this.knownMachines());
    this.snapshot = parsed.text;
    this.errors = parsed.errors;
    this.invalidSource = parsed.errors.length > 0;
    this.config = parsed.config ?? emptyConfig();
    this.forms = this.config.projects.map(formFor);
    this.selected = -1;
    this.form = null;
    const wantedRepo = props()?.repo;
    const rules = this.ruleIndices();
    const index = rules.find(i => !wantedRepo || normalizeRoot(this.config.projects[i].repo) === normalizeRoot(wantedRepo));
    this.selectRule(index ?? rules[0] ?? -1);
    this.loading = false;
    cx.notify();
  }

  reload(cx) {
    cx.spawn(async (cx) => this.load(cx));
  }

  newConfig(cx) {
    this.config = emptyConfig();
    this.forms = [];
    this.form = null;
    this.selected = -1;
    this.errors = [];
    this.error = "";
    this.notice = "A new valid configuration will replace the invalid file only when you save.";
    this.invalidSource = false;
    this.addRule(cx);
  }

  ensureInput(key, value, placeholder = "") {
    const text = String(value ?? "");
    let state = this.inputs[key];
    if (!state) {
      state = InputState.new({ value: text, placeholder });
      state.on("change", (_event, cx) => {
        this.setField(key, state.value());
        cx.notify();
      });
      this.inputs[key] = state;
    } else if (state.value() !== text) {
      state.set_value(text);
    }
    return state;
  }

  ensureInputs() {
    if (!this.form) return;
    this.ensureInput("rule-machine", this.form.machine, "This computer");
    this.ensureInput("rule-repo", this.form.repo, "/absolute/repository/root");
    this.form.commands.forEach((command, index) => {
      this.ensureInput(commandFieldKey(index, "name"), command.name, "setup name");
      this.ensureInput(commandFieldKey(index, "argv"), command.argv, '["bash", "/path/to/setup.sh"]');
      this.ensureInput(commandFieldKey(index, "timeout"), command.timeout, "seconds");
    });
  }
  setField(key, value) {
    if (!this.form) return;
    if (key === "rule-machine") this.form.machine = value;
    else if (key === "rule-repo") this.form.repo = value;
    else if (!updateCommandField(this.form.commands, key, value)) return;
    this.forms[this.selected] = this.form;
    this.error = "";
    this.notice = "";
    this.availability = null;
  }


  ruleIndices() {
    return this.config.projects.flatMap((project, index) =>
      this.machine === undefined || (project.machine ?? null) === this.machine ? [index] : []);
  }

  selectRule(index, cx) {
    if (!this.ruleIndices().includes(index)) {
      this.selected = -1;
      this.form = null;
      if (cx) cx.notify();
      return;
    }
    this.selected = index;
    this.form = this.forms[this.selected] ?? formFor(this.config.projects[this.selected]);
    this.forms[this.selected] = this.form;
    this.error = "";
    this.notice = "";
    this.availability = null;
    this.ensureInputs();
    if (cx) cx.notify();
  }

  addRule(cx) {
    if (this.invalidSource) {
      this.error = "Reload the file or choose Start a new valid configuration before adding a rule.";
      cx.notify();
      return;
    }
    const project = emptyProject();
    project.machine = this.machine ?? null;
    this.config.projects.push(project);
    this.forms.push(formFor(project));
    this.selectRule(this.config.projects.length - 1, cx);
  }

  removeRule(cx) {
    if (this.selected < 0) return;
    this.config.projects.splice(this.selected, 1);
    this.forms.splice(this.selected, 1);
    this.availability = null;
    const remaining = this.ruleIndices();
    this.selectRule(remaining.find(index => index >= this.selected) ?? remaining.at(-1) ?? -1, cx);
  }

  addCommand(cx) {
    if (!this.form) return;
    this.form.commands.push({ name: "", argv: "[]", timeout: "" });
    this.forms[this.selected] = this.form;
    this.ensureInputs();
    this.error = "";
    this.notice = "";
    cx.notify();
  }

  removeCommand(index, cx) {
    if (!this.form) return;
    this.form.commands.splice(index, 1);
    this.forms[this.selected] = this.form;
    this.availability = null;
    this.error = "";
    cx.notify();
  }

  materializeProject(index) {
    const source = this.config.projects[index] ?? emptyProject();
    const form = this.forms[index] ?? formFor(source);
    const errors = [];
    const project = {
      machine: form.machine.trim() || null,
      repo: form.repo.trim(),
      hooks: { on_created: [] },
    };
    for (const [commandIndex, command] of form.commands.entries()) {
      let argv = [];
      try {
        argv = parseArgvText(command.argv);
      } catch (error) {
        errors.push(`Rule ${index + 1}, command ${commandIndex + 1}: ${String(error?.message ?? error)}`);
      }
      project.hooks.on_created.push({
        name: command.name,
        argv,
        timeout_seconds: Number(command.timeout),
      });
    }
    return { project, errors };
  }

  materializeConfig() {
    const projects = [];
    const errors = [];
    for (let index = 0; index < this.config.projects.length; index += 1) {
      const result = this.materializeProject(index);
      projects.push(result.project);
      errors.push(...result.errors);
    }
    const candidate = { version: CONFIG_VERSION, projects };
    errors.push(...validateConfig(candidate, this.knownMachines()));
    return { config: candidate, errors: [...new Set(errors)] };
  }

  async save(cx) {
    if (this.loading) return;
    if (this.invalidSource) {
      this.error = "The file is invalid and was not overwritten. Reload it or choose Start a new valid configuration.";
      cx.notify();
      return;
    }
    const materialized = this.materializeConfig();
    if (materialized.errors.length) {
      this.errors = materialized.errors;
      this.error = "Fix the highlighted configuration errors before saving.";
      cx.notify();
      return;
    }
    const result = await saveConfig({
      path: this.path,
      config: materialized.config,
      expected: this.snapshot,
      readTextFile,
      writeTextFile,
    });
    if (!result.ok) {
      this.error = result.error;
      this.notice = result.conflict ? "Reload is required; no external edit was overwritten." : "";
      cx.notify();
      return;
    }
    this.config = materialized.config;
    this.forms = this.config.projects.map(formFor);
    this.snapshot = result.text;
    this.invalidSource = false;
    this.errors = [];
    this.error = "";
    this.selectRule(this.selected);
    this.notice = "Saved worktree hook rules.";
    cx.notify();
  }

  checkAvailability(cx) {
    if (this.selected < 0) return;
    const materialized = this.materializeProject(this.selected);
    const validation = validateConfig({ version: CONFIG_VERSION, projects: [materialized.project] }, this.knownMachines());
    const errors = [...materialized.errors, ...validation];
    if (errors.length) {
      this.error = errors.join(" ");
      this.availability = null;
      cx.notify();
      return;
    }
    this.checking = true;
    this.availability = null;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.availability = await availabilityChecks(materialized.project, exec);
        this.notice = "Availability checks only: configured setup commands were not run.";
      } catch (error) {
        this.error = `Availability check failed: ${String(error?.message ?? error)}`;
      }
      this.checking = false;
      cx.notify();
    });
  }

  savedProject() {
    return this.selected < 0 ? null : this.config.projects[this.selected] ?? null;
  }

  setupRows(project) {
    if (!project?.repo) return [];
    let all = [];
    try { all = terminals() ?? []; } catch { return []; }
    const matches = all.filter((term) => {
      const labels = labelMap(term);
      return terminalBelongsToMachine(term, project.machine ?? null)
        && normalizeRoot(labels[WORKTREE_LABELS.repo]) === normalizeRoot(project.repo);
    });
    const cwds = [...new Set(matches.map((term) => labelMap(term)[WORKTREE_LABELS.cwd]).filter(Boolean))];
    return cwds
      .map((cwd) => selectSetupResult(matches, { repo: project.repo, cwd }))
      .filter(Boolean)
      .sort((a, b) => rowTime(b) - rowTime(a));
  }

  showTerminal(term, log = false) {
    if (!term?.address) return;
    run("terminal.show", { terminal: term.address });
    run("pane.focus", { terminal: term.address });
    if (log) run("terminal.scroll", { to: "bottom", terminal: term.address });
  }

  retryTerminal(term, cx) {
    const project = this.savedProject();
    if (!project || !term?.address) return;
    const fresh = this.setupRows(project).find((row) => row.address === term.address);
    const guard = retryGuard(fresh, { repo: project.repo, cwd: labelMap(fresh)[WORKTREE_LABELS.cwd] });
    if (!guard.ok) {
      this.error = guard.reason;
      cx.notify();
      return;
    }
    this.showTerminal(fresh);
    this.notice = "Sending the existing exported setup gate to the matching idle shell.";
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await hc(["send", fresh.address, 'sh -c "$HERDR_WORKTREE_GATE"']);
        if (result?.code !== 0) this.error = result?.stderr || result?.stdout || "The terminal rejected the retry command.";
      } catch (error) {
        this.error = `Could not send the retry command: ${String(error?.message ?? error)}`;
      }
      cx.notify();
    });
  }

  button(t, id, text, action, disabled = false, primary = false) {
    return h_flex()
      .id(id)
      .h(28)
      .px(10)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(6)
      .border_1()
      .border_color(disabled ? t.border : primary ? t.accent : t.input)
      .text_size(11.5)
      .text_color(disabled ? t.dim : primary ? t.foreground : t.muted)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_event, cx) => { if (!disabled) action(cx); })
      .child(text);
  }

  inputField(t, label, key, note = "") {
    const state = this.inputs[key];
    return v_flex()
      .flex_none()
      .gap(4)
      .child(div().text_size(11.5).text_color(t.foreground).child(label))
      .child(Input.new(state).h(30).px(8).items_center().rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground))
      .when(Boolean(note), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(note)));
  }

  projectList(t, cx) {
    const rows = this.ruleIndices().map(index => {
      const selected = index === this.selected;
      const draft = this.forms[index] ?? formFor(project);
      const name = draft.repo || "(new rule)";
      const machine = draft.machine.trim() || null;
      const count = draft.commands.length;
      return v_flex()
        .id(`rule-${index}`)
        .flex_none()
        .p(8)
        .gap(3)
        .rounded(7)
        .cursor_pointer()
        .when(selected, (el) => el.bg(t.selected))
        .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.selectRule(index, cx))
        .child(div().truncate().text_color(t.foreground).child(name))
        .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
          .child(machine ?? "This computer")
          .child(`· ${count} command${count === 1 ? "" : "s"}`));
    });
    return v_flex()
      .id("rules-panel")
      .w(230)
      .flex_none()
      .h_full()
      .min_h(0)
      .gap(8)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_color(t.foreground).child("Rules"))
        .child(this.button(t, "add-rule", "Add", (cx) => this.addRule(cx), this.invalidSource)))
      .child(v_flex().id("rules-list").flex_1().min_h(0).overflow_y_scroll().gap(3).p(4).rounded(8).border_1().border_color(t.border).bg(t.background)
        .children(rows)
        .when(rows.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No saved rules."))));
  }

  commandsEditor(t, cx) {
    return v_flex()
      .flex_none()
      .gap(8)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_color(t.foreground).child("on_created commands"))
        .child(this.button(t, "add-command", "Add command", (cx) => this.addCommand(cx))))
      .child(div().text_size(10.5).text_color(t.dim).child("Commands run sequentially after a worktree is created. argv is JSON array text, not shell command text."))
      .children(this.form.commands.map((command, index) => v_flex()
        .id(`command-${index}`)
        .flex_none()
        .gap(6)
        .p(8)
        .rounded(7)
        .border_1()
        .border_color(t.border)
        .child(h_flex().items_center()
          .child(div().flex_1().text_color(t.foreground).child(`Command ${index + 1}`))
          .child(this.button(t, `remove-command-${index}`, "Remove", (cx) => this.removeCommand(index, cx))))
        .child(this.inputField(t, "Name", commandFieldKey(index, "name"), "Displayed in the setup terminal."))
        .child(this.inputField(t, "argv JSON (array, not shell text)", commandFieldKey(index, "argv"), '["bash", "/absolute/path/setup.sh"]'))
        .child(this.inputField(t, "Timeout seconds", commandFieldKey(index, "timeout"), "Positive whole seconds; timeout is enforced by the gate."))))
      .when(this.form.commands.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No setup commands; worktree creation will open normally.")));
  }

  availabilityPanel(t) {
    if (!this.availability) return null;
    const result = this.availability;
    const check = (label, value) => h_flex().gap(6).items_center().text_size(11).child(div().text_color(t.foreground).child(label)).child(div().text_color(value.ok ? t.accent : t.blocked).child(value.ok ? "available" : (value.detail || "not available")));
    return v_flex().flex_none().gap(5).p(8).rounded(7).border_1().border_color(t.border)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_color(t.foreground).child("Availability checks"))
        .child(div().text_size(10.5).text_color(t.dim).child(result.checked_only ? "checks only" : "")))
      .child(check("Root", result.root))
      .children(result.commands.map((command, index) => v_flex().flex_none().gap(3)
        .child(check(`${index + 1}. ${command.name || "Unnamed"} executable`, command.executable))
        .when(Boolean(command.script), (el) => el.child(check(`   explicit script ${command.script_operand}`, command.script)))))
      .child(div().text_size(10.5).text_color(t.dim).child("This does not run setup or verify arbitrary dependencies inside a script."));
  }

  resultsPanel(t, cx) {
    const project = this.savedProject();
    const rows = this.setupRows(project);
    return v_flex().flex_none().gap(6).pt(8)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_color(t.foreground).child("Setup status"))
        .child(div().text_size(10.5).text_color(t.dim).child("Live terminal labels")))
      .when(rows.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("No labeled setup terminal for this saved rule.")))
      .children(rows.map((term, index) => {
        const labels = labelMap(term);
        const status = labels[WORKTREE_LABELS.status] ?? "unknown";
        const reason = labels[WORKTREE_LABELS.exitreason] ?? "";
        const guard = retryGuard(term, { repo: project.repo, cwd: labels[WORKTREE_LABELS.cwd] });
        return v_flex().id(`setup-result-${index}`).flex_none().gap(4).p(8).rounded(7).border_1().border_color(t.border)
          .child(h_flex().items_center()
            .child(div().flex_1().text_color(t.foreground).truncate().child(labels[WORKTREE_LABELS.cwd] ?? term.address))
            .child(div().text_size(11).text_color(status === "succeeded" ? t.accent : status === "failed" ? t.blocked : t.muted).child(`${status}${reason ? ` · ${reason}` : ""}`)))
          .child(h_flex().gap(6)
            .child(this.button(t, `focus-${index}`, "Focus", () => this.showTerminal(term)))
            .child(this.button(t, `log-${index}`, "Log", () => this.showTerminal(term, true)))
            .child(this.button(t, `retry-${index}`, "Retry setup", (cx) => this.retryTerminal(term, cx), !guard.ok)));
      }));
  }

  editor(t, cx) {
    if (this.invalidSource) {
      return v_flex().flex_1().min_w(0).gap(10)
        .child(div().font_semibold().text_color(t.foreground).child("Invalid worktree-hooks.json"))
        .children(this.errors.map((error, index) => div().id(`config-error-${index}`).text_size(11).text_color(t.blocked).child(error)))
        .child(div().text_size(11).text_color(t.dim).child("No invalid source will be overwritten accidentally."))
        .child(h_flex().gap(8)
          .child(this.button(t, "reload-config", "Reload", (cx) => this.reload(cx)))
          .child(this.button(t, "new-config", "Start a new valid configuration", (cx) => this.newConfig(cx), false, true)));
    }
    if (!this.form) {
      return v_flex().flex_1().min_w(0).gap(10)
        .child(div().font_semibold().text_color(t.foreground).child("Worktree hook settings"))
        .child(div().text_color(t.dim).child("Add a rule for a repository to run setup commands after creating its worktree."))
        .child(this.button(t, "empty-add-rule", "Add rule", (cx) => this.addRule(cx), false, true));
    }
    // Input states are created when the selected rule changes, never during render.
    return v_flex().flex_1().min_w(0).gap(10)
      .child(h_flex().items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Rule"))
        .child(this.button(t, "remove-rule", "Remove rule", (cx) => this.removeRule(cx))))
      .child(h_flex().gap(8).children([
        ...(this.machine === undefined ? [this.inputField(t, "Machine (blank = this computer)", "rule-machine", "Use a machine name known to Herdr.")] : []),
        this.inputField(t, "Repository root", "rule-repo", "Absolute path; matching is normalized."),
      ]))
      .child(this.commandsEditor(t, cx))
      .child(h_flex().gap(8)
        .child(this.button(t, "check-availability", this.checking ? "Checking…" : "Check availability", (cx) => this.checkAvailability(cx), this.checking))
        .child(div().flex_1().text_size(10.5).text_color(t.dim).child("Checks run on the selected machine and never invoke setup.")))
      .when(Boolean(this.availability), (el) => el.child(this.availabilityPanel(t)))
      .child(this.resultsPanel(t, cx));
  }

  render(cx) {
    const t = theme();
    return v_flex()
      .id("worktree-hook-settings")
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.key(event, cx))
      .size_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(this.machine === undefined ? "Worktree hooks" : `Worktree hooks · ${this.machine ?? "This computer"}`))
        .child(div().text_size(10.5).text_color(t.dim).child(this.path))
        .child(this.button(t, "close-settings", "Close", () => this.close())))
      .when(this.loading, (el) => el.child(div().text_color(t.dim).child("Loading…")))
      .when(!this.loading, (el) => el.child(h_flex().flex_1().min_h(0).gap(12).items_start()
        .child(this.projectList(t, cx))
        .child(div().relative().flex_1().min_w(0).min_h(0).h_full().child(v_flex().id("settings-editor-scroll").size_full().overflow_y_scroll().gap(10).child(this.editor(t, cx))).child(Scrollbar.vertical("settings-editor-scroll").absolute().inset_0()))))
      .when(Boolean(this.error || this.errors.length || this.notice), (el) => el.child(v_flex().flex_none().gap(3)
        .when(Boolean(this.error), (x) => x.child(div().text_size(11).text_color(t.blocked).child(this.error)))
        .when(this.errors.length > 0 && !this.invalidSource, (x) => x.children(this.errors.map((error, index) => div().id(`footer-error-${index}`).text_size(11).text_color(t.blocked).child(error))))
        .when(Boolean(this.notice), (x) => x.child(div().text_size(11).text_color(t.dim).child(this.notice)))))
      .child(h_flex().flex_none().justify_end().gap(8)
        .child(this.button(t, "reload-footer", "Reload", (cx) => this.reload(cx)))
        .child(this.button(t, "save-settings", "Save", (cx) => cx.spawn(async (cx) => this.save(cx)), this.loading || this.invalidSource, true))
        .child(this.button(t, "close-footer", "Close", () => this.close())));
  }
}
