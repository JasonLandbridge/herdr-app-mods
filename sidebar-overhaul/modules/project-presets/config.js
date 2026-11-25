// The project list: ~/.config/herdr-app/data/projects.json, hand-editable.
import { readTextFile, writeTextFile, appHome } from "herdr";
import { flatDestination, machineKey, parseConfig, validateWorktreeDirectory } from "../../config.js";
import { normalize, normalizeScan } from "./lib.js";

export const sidebarConfigPath = () => `${appHome()}/mods/sidebar-overhaul/sidebar.config.json`;

/** Read the source-owned sidebar config; creation must not proceed without a valid machine root. */
export async function resolveWorktreeDestination(repository, branch, machine = null) {
  let text;
  try { text = await readTextFile(sidebarConfigPath()); } catch (error) {
    throw new Error(`Could not read ${sidebarConfigPath()}: ${error.message}`);
  }
  if (typeof text !== "string" || text.length === 0) throw new Error(`${sidebarConfigPath()} is missing or empty`);
  let config;
  try { config = parseConfig(text); } catch (error) {
    throw new Error(`${sidebarConfigPath()} is invalid: ${error.message}`);
  }
  const key = machineKey(machine);
  const entry = config.machines[key];
  if (!entry || typeof entry !== "object") throw new Error(`Sidebar config has no machine entry for ${key}`);
  const root = validateWorktreeDirectory(entry.worktreeDirectory);
  return { machine: key, root, destination: flatDestination(root, repository, branch) };
}

export const dataFilePath = () => `${appHome()}/data/project-presets.json`;

/** { projects, raw }: raw is the file as read, handed back to saveConfig so a
 *  hand edit made in between is refused instead of overwritten. */
export async function loadConfig() {
  const raw = await readTextFile(dataFilePath());
  if (raw == null) return { projects: [], layouts: [], gitInfo: true, hideTemplate: false, scan: normalizeScan(), raw: null };
  try {
    const data = JSON.parse(raw);
    return { projects: (data.projects ?? []).map(normalize), layouts: Array.isArray(data.layouts) ? data.layouts : [], gitInfo: data.gitInfo !== false, hideTemplate: data.hideTemplate === true, scan: normalizeScan(data.scan), raw };
  } catch (e) {
    throw new Error(`${dataFilePath()} is not valid JSON: ${e.message}`);
  }
}

/** `extra` sets other top-level keys (for instance `hideTemplate`); everything else already in the file is kept. */
export async function saveConfig(projects, raw, extra = {}) {
  // Everything else in the file (the layouts, a hand-added key) is kept as it is.
  let rest = {};
  try { rest = JSON.parse(raw ?? "{}"); } catch {}
  const text = JSON.stringify({ ...rest, ...extra, projects }, null, 2) + "\n";
  await writeTextFile(dataFilePath(), text, raw);
  return text;
}

// Which repo preset files (.herdr/project-presets.json) the person has looked at: { "<folder>": { text, use } }. `text` is
// the file as it was when they answered, so a file that has changed since is asked about again; `use` is their answer.
// Kept beside the data file, not in it: it is about this machine, and an export should not carry it.
export const trustFilePath = () => `${appHome()}/data/project-presets.trust.json`;

/** { trust, raw }; a missing or unreadable file is no answers at all (every preset file is asked about again). */
export async function loadTrust() {
  const raw = await readTextFile(trustFilePath());
  if (raw == null) return { trust: {}, raw: null };
  try {
    const data = JSON.parse(raw);
    const trust = {};
    for (const [folder, t] of Object.entries(data && typeof data === "object" ? data : {})) if (t && typeof t.text === "string") trust[folder] = { text: t.text, use: t.use === true };
    return { trust, raw };
  } catch { return { trust: {}, raw }; }
}

export async function saveTrust(trust, raw) {
  const text = JSON.stringify(trust, null, 2) + "\n";
  await writeTextFile(trustFilePath(), text, raw);
  return text;
}
