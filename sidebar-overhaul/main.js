import { View, div } from "gpui-kit";
import Sidebar from "./modules/over9k/main.js";
import NewMenu from "./modules/over9k-new-menu/main.js";
import Menu from "./modules/over9k-menu/main.js";
import Options from "./modules/over9k-options/main.js";
import Worktree from "./modules/over9k-worktree/main.js";
import MachineWorktree from "./modules/over9k-worktree/machine-worktree.js";
import WorktreeSettings from "./modules/over9k-worktree-settings/main.js";
import Close from "./modules/over9k-close/main.js";
import Handoff from "./modules/over9k-handoff/main.js";
import Panel from "./modules/over9k-panel/main.js";
import Recovery from "./modules/over9k-recovery/main.js";
import Rename from "./modules/over9k-rename/main.js";
import ServerStop from "./modules/over9k-server-stop/main.js";
import Switcher from "./modules/over9k-switcher/main.js";
import WorkingSets from "./modules/over9k-working-sets/main.js";
import Tabs from "./modules/over9k-tabs/main.js";
import ProjectPresets from "./modules/project-presets/main.js";
import ProjectPresetsLauncher from "./modules/project-presets/launcher.js";
import { focused, nextCommand, openOverlay, props } from "herdr";
import { plan } from "./close-plan.js";
/** @type {Record<string, import("gpui-kit").ViewClass>} */
const views = {
  sidebar: Sidebar,
  menu: Menu,
  "new-menu": NewMenu,
  options: Options,
  worktree: Worktree,
  "machine-worktree": MachineWorktree,
  "worktree-settings": WorktreeSettings,
  close: Close,
  handoff: Handoff,
  panel: Panel,
  recovery: Recovery,
  rename: Rename,
  switcher: Switcher,
  "working-sets": WorkingSets,
  tabs: Tabs,
  "project-presets": ProjectPresets,
  "project-presets-launcher": ProjectPresetsLauncher,
};
const viewClass = (view) => views[view] ?? Sidebar;

const launchProjectPresets = () => openOverlay({ mod: "sidebar-overhaul", kind: "popup", at: "top", offset: 40, width: 1060, height: 0.8, props: { view: "project-presets" } });
const launchSwitcher = () => openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 460, height: 520, props: { view: "switcher" } });
const launchClose = (target) => { if (target && plan(target).requiresConfirmation) openOverlay({ mod: "sidebar-overhaul", kind: "dialog", width: 620, height: 520, props: { ...target, view: "close" } }); };
const commandLoop = (cx, owner) => cx.spawn(async () => { for (;;) {
  const command = await nextCommand();
  if (command === "project-presets") launchProjectPresets();
  else if (command === "switcher") launchSwitcher();
  else if (command === "close-tab") { const f = focused(); if (f?.tab) launchClose({ tabs: [f.tab] }); }
  else if (command === "close-pane") { const f = focused(); if (f?.pane) launchClose({ panes: [f.pane] }); }
  else if (owner.view === "switcher") {
    const name = command.startsWith("switcher.") ? command.slice("switcher.".length) : command;
    if (name === "next" || name === "prev" || name === "focus") owner.sendChildCommand(name);
  }
  }
});
export default class SidebarOverhaul extends View {
  init(viewProps, cx) {
    this.cx = cx;
    this.viewProps = viewProps ?? {};
    if (!this.viewProps.view && !this.viewProps.tab) this.viewProps = props() ?? this.viewProps;
    this.view = this.viewProps.tab === "pane" ? "menu" : this.viewProps.view ?? "sidebar";
    this.childClass = viewClass(this.view);
    commandLoop(cx, this);
    this.child = cx.new(this.childClass, this.viewProps);
  }

  /** @param {import("gpui-shell").Props | undefined} nextProps */
  update(nextProps) {
    this.viewProps = nextProps ?? {};
    if (!this.viewProps.view && !this.viewProps.tab) this.viewProps = props() ?? this.viewProps;
    this.view = this.viewProps.tab === "pane" ? "menu" : this.viewProps.view ?? "sidebar";
    const nextClass = viewClass(this.view);
    if (nextClass !== this.childClass) {
      this.child?.release();
      this.childClass = nextClass;
      this.child = this.cx.new(nextClass, this.viewProps);
      return;
    }
    this.child?.set_props(this.viewProps);
  }

  sendChildCommand(command) {
    this.viewProps = { ...this.viewProps, command: { id: (this.commandId ??= 0) + 1, name: command } };
    this.child?.set_props(this.viewProps);
  }

  render() {
    return this.child ?? div();
  }
}

