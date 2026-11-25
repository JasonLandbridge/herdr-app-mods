// Pure state and visibility operations for saved sidebar working sets.
// A set stores the groups that should remain visible, never individual agent
// hides. Applying one therefore changes only group visibility.

export const WORKING_SETS_STATE = "over9k.workingSets";
export const WORKING_SETS_VERSION = 1;

const isRecord = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const path = (value) => {
  const result = text(value);
  return result ? result.replace(/\\/g, "/").replace(/\/+$/, "") || "/" : null;
};
const timestamp = (value, fallback = Date.now()) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function selector(value, keyHint = null) {
  if (typeof value === "string") return { key: value, nativeKey: value, label: value, folder: null, machine: null, kind: "project" };
  if (!isRecord(value)) return null;
  const nativeKey = text(value.nativeKey ?? value.key ?? value.id) ?? text(keyHint);
  if (!nativeKey) return null;
  const folder = path(value.folder);
  const machine = text(value.machine) ?? null;
  const kind = value.kind === "space" ? "space" : "project";
  // Space ids are local document ids and change after reboot. Persist a
  // machine+folder selector instead; project keys already have that identity.
  const key = text(value.selectorKey) ?? (kind === "space" && folder ? `s:${machine ?? "local"}:${folder}` : nativeKey);
  return {
    key,
    nativeKey,
    label: text(value.label ?? value.name) ?? key,
    folder,
    machine,
    kind,
  };
}

function normalizeSet(value, keyHint = null, now = Date.now()) {
  if (!isRecord(value)) return null;
  const id = text(value.id) ?? text(keyHint);
  if (!id) return null;
  const selectors = [];
  for (const item of Array.isArray(value.selectors) ? value.selectors : []) {
    const clean = selector(item);
    if (clean && !selectors.some((x) => x.key === clean.key)) selectors.push(clean);
  }
  selectors.sort((a, b) => a.key.localeCompare(b.key));
  return {
    id,
    name: text(value.name) ?? id,
    selectors,
    createdAt: timestamp(value.createdAt, now),
    updatedAt: timestamp(value.updatedAt, now),
  };
}

export function emptyWorkingSetsState() {
  return { version: WORKING_SETS_VERSION, active: null, sets: {} };
}

export function normalizeWorkingSetsState(value) {
  const state = emptyWorkingSetsState();
  if (!isRecord(value)) return state;
  state.active = text(value.active);
  const sets = isRecord(value.sets) ? value.sets : {};
  for (const [id, valueSet] of Object.entries(sets)) {
    const clean = normalizeSet(valueSet, id);
    if (clean) state.sets[clean.id] = clean;
  }
  if (state.active && !state.sets[state.active]) state.active = null;
  return state;
}

function groupEntries(groups) {
  if (groups instanceof Map) return [...groups.entries()];
  if (Array.isArray(groups)) return groups.map((item) => [item?.key, item]);
  return Object.entries(isRecord(groups) ? groups : {});
}

/** Return stable machine-qualified selectors for all currently visible groups. */
export function visibleGroupSelectors(groups, hidden = {}) {
  const hiddenKeys = new Set(Object.keys(isRecord(hidden) ? hidden : {}));
  const out = [];
  for (const [key, value] of groupEntries(groups)) {
    const clean = selector({ ...(isRecord(value) ? value : {}), key: value?.key ?? key });
    if (!clean || hiddenKeys.has(clean.key) || hiddenKeys.has(clean.nativeKey)) continue;
    out.push(clean);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export const selectorsFromGroups = visibleGroupSelectors;

function allSelectors(value) {
  return (Array.isArray(value) ? value : []).map((item) => selector(item)).filter(Boolean);
}

function selectedKeys(value) {
  return new Set(allSelectors(value).map((item) => item.key));
}

/** Save the visible groups from the current sidebar frame. */
export function saveWorkingSet(value, spec = {}, now = Date.now()) {
  const state = normalizeWorkingSetsState(value);
  const input = typeof spec === "string" ? { name: spec } : (isRecord(spec) ? spec : {});
  const id = text(input.id) ?? `working-set-${timestamp(now)}`;
  const old = state.sets[id];
  const clean = normalizeSet({
    id,
    name: input.name ?? old?.name ?? id,
    selectors: input.selectors ?? [],
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  }, id, now);
  state.sets[id] = clean;
  state.active = id;
  return state;
}

export function selectWorkingSet(value, id) {
  const state = normalizeWorkingSetsState(value);
  const key = text(id);
  state.active = key && state.sets[key] ? key : null;
  return state;
}

export function renameWorkingSet(value, id, name, now = Date.now()) {
  const state = normalizeWorkingSetsState(value);
  const key = text(id);
  if (!key || !state.sets[key]) return state;
  state.sets[key] = { ...state.sets[key], name: text(name) ?? state.sets[key].name, updatedAt: now };
  return state;
}

export function deleteWorkingSet(value, id) {
  const state = normalizeWorkingSetsState(value);
  const key = text(id);
  if (!key) return state;
  delete state.sets[key];
  if (state.active === key) state.active = null;
  return state;
}

/**
 * Apply a saved set to visibility state. Explicit individual hides are copied
 * unchanged; only the group map is replaced for the supplied frame selectors.
 */
export function applyWorkingSetVisibility(visibility, setOrSelectors, frameSelectors = []) {
  const source = isRecord(visibility) ? visibility : {};
  const state = {
    ...source,
    hidden: isRecord(source.hidden) ? { ...source.hidden } : {},
    groups: isRecord(source.groups) ? { ...source.groups } : {},
    effective: {},
    groupEffective: {},
  };
  const selected = isRecord(setOrSelectors) ? setOrSelectors.selectors : setOrSelectors;
  const wanted = selected === "all" || selected == null ? null : selectedKeys(selected);
  const selectors = allSelectors(frameSelectors);
  if (wanted === null) {
    state.groups = {};
    return state;
  }
  const nextGroups = {};
  for (const item of selectors) {
    if (wanted.has(item.key)) continue;
    const nativeKey = item.nativeKey ?? item.key;
    nextGroups[nativeKey] = { ...item, key: nativeKey };
  }
  state.groups = nextGroups;
  return state;
}

export function applyWorkingSet(value, visibility, id, frameSelectors = []) {
  const state = normalizeWorkingSetsState(value);
  if (id === "all") return applyWorkingSetVisibility(visibility, "all", frameSelectors);
  const set = state.sets[text(id)];
  return set ? applyWorkingSetVisibility(visibility, set, frameSelectors) : { ...visibility };
}

export function workingSetEntries(value) {
  return Object.values(normalizeWorkingSetsState(value).sets).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function selectorsEqual(a, b) {
  const left = [...selectedKeys(a)].sort();
  const right = [...selectedKeys(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
