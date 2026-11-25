export const RELOAD_KEY = "over9k.reload";

const asText = (value) => String(value ?? "");

/** Parse porcelain status while preserving the exact local fingerprint. */
export function parseLocalStatus(status) {
  const fingerprint = asText(status);
  const files = fingerprint.split("\n").filter(Boolean);
  return {
    fingerprint,
    files,
    paths: files.map((line) => /^[ MADRCU?!][ MADRCU?!] /.test(line) ? line.slice(3) : line),
    dirty: files.length > 0,
    staged: files.some((line) => line[0] && line[0] !== " " && line[0] !== "?"),
    unstaged: files.some((line) => !line.startsWith("??") && line[1] && line[1] !== " "),
    untracked: files.some((line) => line.startsWith("??")),
  };
}

/** Return changed Over9k mod names in deterministic order. */
export function changedMods(files, prefix = "over9k/mods/") {
  const root = prefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") + "/";
  return [...new Set(asText(files).split("\n").map((file) => file.replace(/^\.\//, "").replace(/\\/g, "/")))]
    .filter((file) => file.startsWith(root))
    .map((file) => file.slice(root.length).split("/")[0])
    .filter(Boolean)
    .sort();
}

export function focusSnapshot(focus) {
  if (!focus) return null;
  return {
    space: focus.space ?? null,
    tab: focus.tab ?? null,
    pane: focus.pane ?? null,
    terminal: focus.terminal ?? null,
  };
}

export function focusRestoreCommands(focus) {
  const saved = focusSnapshot(focus);
  if (!saved) return [];
  const commands = [];
  if (saved.space) commands.push({ name: "space.select", args: { id: saved.space } });
  if (saved.tab) commands.push({ name: "tab.select", args: { id: saved.tab } });
  if (saved.pane) commands.push({ name: "pane.focus", args: { pane: saved.pane } });
  else if (saved.terminal) commands.push({ name: "pane.focus", args: { terminal: saved.terminal } });
  return commands;
}

/** Recreate the supported layout, then restore space, tab and pane focus. */
export function reloadPlan({ layoutName, focus, affectedMods = [] } = {}) {
  if (!layoutName) return { ok: false, error: "The current layout is unavailable; local mods were not reloaded." };
  return {
    ok: true,
    layoutName,
    affectedMods: [...new Set(affectedMods)].sort(),
    warning: "Reloading recreates the layout and closes floating windows and mod session state; running terminals stay alive.",
    commands: [
      { name: "layout.switch", args: {} },
      { name: "layout.switch", args: { name: layoutName } },
      ...focusRestoreCommands(focus),
    ],
  };
}

export function makeReloadRequest({ requestId, layoutName, focus, affectedMods, requestedAt = Date.now() } = {}) {
  return {
    requestId: asText(requestId),
    status: "pending",
    layoutName: asText(layoutName),
    affected: [...new Set(affectedMods ?? [])].sort(),
    focus: focusSnapshot(focus),
    requestedAt,
  };
}
