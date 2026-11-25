import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedMods,
  focusRestoreCommands,
  makeReloadRequest,
  parseLocalStatus,
  reloadPlan,
} from "./local-reload.js";

test("local status keeps a fingerprint and finds changed Over9k mods", () => {
  const status = parseLocalStatus(" M over9k/mods/over9k-options/main.js\n?? over9k/mods/over9k-footer/local.js\n M README.md\n");
  assert.equal(status.dirty, true);
  assert.equal(status.unstaged, true);
  assert.equal(status.untracked, true);
  assert.deepEqual(status.paths, [
    "over9k/mods/over9k-options/main.js",
    "over9k/mods/over9k-footer/local.js",
    "README.md",
  ]);
  assert.deepEqual(changedMods(status.paths.join("\n")), ["over9k-footer", "over9k-options"]);
});

test("reload plan recreates the layout before restoring focus", () => {
  const plan = reloadPlan({
    layoutName: "over9k",
    affectedMods: ["over9k-options", "over9k-footer", "over9k-options"],
    focus: { space: "space-1", tab: "tab-1", pane: "pane-1", terminal: "terminal-1" },
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.affectedMods, ["over9k-footer", "over9k-options"]);
  assert.deepEqual(plan.commands, [
    { name: "layout.switch", args: {} },
    { name: "layout.switch", args: { name: "over9k" } },
    { name: "space.select", args: { id: "space-1" } },
    { name: "tab.select", args: { id: "tab-1" } },
    { name: "pane.focus", args: { pane: "pane-1" } },
  ]);
  assert.deepEqual(focusRestoreCommands({ terminal: "terminal-1" }), [
    { name: "pane.focus", args: { terminal: "terminal-1" } },
  ]);
  assert.match(plan.warning, /floating windows.*terminals/i);
});

test("reload requests carry consent-approved mods and focus", () => {
  const request = makeReloadRequest({
    requestId: "reload-1",
    layoutName: "over9k",
    affectedMods: ["over9k-options", "over9k-footer", "over9k-options"],
    focus: { space: "space-1", tab: "tab-1", pane: "pane-1" },
    requestedAt: 42,
  });
  assert.deepEqual(request, {
    requestId: "reload-1",
    status: "pending",
    layoutName: "over9k",
    affected: ["over9k-footer", "over9k-options"],
    focus: { space: "space-1", tab: "tab-1", pane: "pane-1", terminal: null },
    requestedAt: 42,
  });
});
