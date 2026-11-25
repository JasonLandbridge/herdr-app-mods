import { appHome, readTextFile, writeTextFile } from "herdr";
import { loadConfig, saveConfig } from "./config.js";

export const sidebarConfigPath = () => `${appHome()}/mods/sidebar-overhaul/sidebar.config.json`;


/** The latest confirmed config in this module's shared, per-version context. */
export function currentSidebarConfig() {
  return current?.config ?? null;
}
let current = null;
let loading = null;

export async function getSidebarConfig(observed = {}) {
  if (current) return current;
  if (!loading) {
    loading = loadConfig({ path: sidebarConfigPath(), readTextFile, writeTextFile, observed })
      .then((result) => {
        current = result;
        return current;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

export async function updateSidebarConfig(mutator, observed = {}) {
  const loaded = await getSidebarConfig(observed);
  const next = await mutator(JSON.parse(JSON.stringify(loaded.config)));
  const result = await saveConfig({
    path: sidebarConfigPath(),
    config: next,
    expected: loaded.raw,
    readTextFile,
    writeTextFile,
  });
  if (!result.ok) throw new Error(result.error);
  current = { config: result.config, raw: result.raw, bootstrapped: false };
  return current;
}

export function publishSidebarConfig(result) {
  current = result;
}

export function clearSidebarConfigCache() {
  current = null;
  loading = null;
}
