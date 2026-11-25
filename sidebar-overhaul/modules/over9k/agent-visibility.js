// Pure visibility state for the sidebar. The context menu submits actions through
// the shared queue; the sidebar owns reduction against its current frame.

export const VISIBILITY_STATE = "herdr-custom.agentVisibility";
export const VISIBILITY_ACTIONS = "herdr-custom.agentVisibility.actions";
export const VISIBILITY_VERSION = 1;

import { isAgentTerminal as classifyAgentTerminal } from "./agent-classifier.js";

export function emptyVisibilityState() {
  return { version: VISIBILITY_VERSION, open: false, hidden: {}, revealed: {}, groups: {}, effective: {}, groupEffective: {} };
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function cleanAddress(address) {
  return typeof address === "string" && address.trim() ? address.trim() : null;
}
function createdMsOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeHidden(value) {
  const metadata = {};
  if (!isRecord(value)) return metadata;
  const created_ms = createdMsOf(value.created_ms);
  if (created_ms !== null) metadata.created_ms = created_ms;
  if (typeof value.recordKey === "string" && value.recordKey.trim()) metadata.recordKey = value.recordKey.trim();
  return metadata;
}

export function normalizeVisibilityState(value) {
  const state = emptyVisibilityState();
  if (!isRecord(value)) return state;
  state.open = value.open === true;
  for (const [address, info] of Object.entries(isRecord(value.hidden) ? value.hidden : {})) {
    const clean = cleanAddress(address);
    if (!clean) continue;
    state.hidden[clean] = normalizeHidden(info);
  }
  for (const [address, info] of Object.entries(isRecord(value.revealed) ? value.revealed : {})) {
    const clean = cleanAddress(address);
    if (!clean) continue;
    state.revealed[clean] = normalizeHidden(info);
  }
  for (const [key, group] of Object.entries(isRecord(value.groups) ? value.groups : {})) {
    const clean = cleanAddress(key);
    if (!clean) continue;
    state.groups[clean] = normalizeGroup(clean, group);
  }
  for (const [address, info] of Object.entries(isRecord(value.effective) ? value.effective : {})) {
    const clean = cleanAddress(address);
    if (!clean) continue;
    state.effective[clean] = {
      inheritedFrom: cleanAddress(info?.inheritedFrom),
      explicit: info?.explicit === true,
    };
  }
  for (const [address, info] of Object.entries(isRecord(value.groupEffective) ? value.groupEffective : {})) {
    const clean = cleanAddress(address);
    const group = cleanAddress(info?.group);
    if (!clean || !group) continue;
    state.groupEffective[clean] = {
      group,
      inheritedFrom: cleanAddress(info?.inheritedFrom),
    };
  }
  return state;
}
export function isExplicitlyHidden(value, address, terminal = null) {
  const clean = cleanAddress(address);
  if (!clean) return false;
  const hidden = isRecord(value?.hidden) ? value.hidden : {};
  if (!Object.prototype.hasOwnProperty.call(hidden, clean)) return false;
  const expected = createdMsOf(hidden[clean]?.created_ms);
  const actual = createdMsOf(terminal?.created_ms);
  return expected === null || actual === null || expected === actual;
}

export function isRevealed(value, address, terminal = null) {
  const clean = cleanAddress(address);
  if (!clean) return false;
  const revealed = isRecord(value?.revealed) ? value.revealed : {};
  if (!Object.prototype.hasOwnProperty.call(revealed, clean)) return false;
  const expected = createdMsOf(revealed[clean]?.created_ms);
  const actual = createdMsOf(terminal?.created_ms);
  return expected === null || actual === null || expected === actual;
}

function normalizeGroup(key, value) {
  const label = typeof value?.label === "string" && value.label.trim() ? value.label.trim() : key;
  const machine = value?.machine == null ? null : cleanAddress(value.machine);
  const folder = value?.folder == null ? null : cleanAddress(value.folder);
  return {
    kind: value?.kind === "space" ? "space" : "project",
    label,
    machine,
    folder,
  };
}

export function startVisibilitySession(value) {
  const state = normalizeVisibilityState(value);
  return { ...state, open: false, effective: {}, groupEffective: {} };
}

function addressesOf(action) {
  const source = action?.addresses ?? (action?.address ? [action.address] : []);
  return [...new Set((Array.isArray(source) ? source : [source]).map(cleanAddress).filter(Boolean))];
}

function groupKeyOf(action) {
  return cleanAddress(action?.group?.key ?? action?.groupKey ?? action?.key);
}

function groupValueOf(action) {
  return action?.group && isRecord(action.group) ? action.group : action;
}

export function applyVisibilityAction(value, action) {
  const state = normalizeVisibilityState(value);
  if (!isRecord(action)) return state;
  if (action.type === "hide") {
    for (const address of addressesOf(action)) {
      state.hidden[address] = {};
      delete state.revealed[address];
    }
  } else if (action.type === "hide-group") {
    const key = groupKeyOf(action);
    if (key) state.groups[key] = normalizeGroup(key, groupValueOf(action));
  } else if (action.type === "restore") {
    for (const address of addressesOf(action)) {
      delete state.hidden[address];
      delete state.revealed[address];
    }
  } else if (action.type === "reveal") {
    const entries = isRecord(action.entries) ? action.entries : {};
    for (const address of addressesOf(action)) state.revealed[address] = normalizeHidden(entries[address]);
  } else if (action.type === "restore-group") {
    const key = groupKeyOf(action);
    if (key) delete state.groups[key];
  } else if (action.type === "restore-all") {
    state.hidden = {};
    state.revealed = {};
    state.groups = {};
  } else if (action.type === "toggle") {
    state.open = !state.open;
  } else if (action.type === "set-open") {
    state.open = action.open === true;
  }
  state.effective = {};
  state.groupEffective = {};
  return state;
}

function terminalMap(terminals) {
  return new Map((Array.isArray(terminals) ? terminals : []).filter((t) => cleanAddress(t?.address)).map((t) => [t.address, t]));
}

function isAgentTerminal(term, agentAddresses) {
  return Boolean(term && classifyAgentTerminal(term, agentAddresses));
}

/**
 * Build the effective hidden map. Explicit selections are roots unless an
 * explicitly hidden ancestor exists; every known agent child inherits the
 * nearest hidden root, including children discovered after the parent hide.
 */
export function effectiveVisibility(value, agents = [], terminals = []) {
  const state = normalizeVisibilityState(value);
  const terms = terminalMap(terminals);
  const revealed = new Set(Object.keys(state.revealed).filter((address) => isRevealed(state, address, terms.get(address))));
  const explicit = new Set(Object.keys(state.hidden).filter((address) => isExplicitlyHidden(state, address, terms.get(address))));
  const agentAddresses = new Set((Array.isArray(agents) ? agents : []).map((a) => a?.address).filter(Boolean));
  for (const term of terms.values()) if (term.state === "live" && isAgentTerminal(term, agentAddresses)) agentAddresses.add(term.address);
  const effective = {};
  for (const address of explicit) if (!revealed.has(address)) effective[address] = { inheritedFrom: null, explicit: true };
  for (const address of agentAddresses) {
    if (revealed.has(address)) continue;
    let current = terms.get(address);
    let inheritedFrom = null;
    const seen = new Set();
    while (current?.parent && !seen.has(current.parent)) {
      const parent = current.parent;
      if (explicit.has(parent)) {
        inheritedFrom = parent;
        break;
      }
      seen.add(parent);
      current = terms.get(parent);
    }
    if (inheritedFrom) effective[address] = { inheritedFrom, explicit: explicit.has(address) };
    else if (explicit.has(address) && !revealed.has(address)) effective[address] = { inheritedFrom: null, explicit: true };
  }
  return effective;
}

export function groupEffectiveVisibility(value, agents = [], terminals = [], layout = {}) {
  const state = normalizeVisibilityState(value);
  const terms = terminalMap(terminals);
  const groupByAddress = isRecord(layout?.groups) ? layout.groups : {};
  const parentByAddress = isRecord(layout?.parents) ? layout.parents : {};
  const hiddenGroups = new Set(Object.keys(state.groups));
  const revealed = new Set(Object.keys(state.revealed).filter((address) => isRevealed(state, address, terms.get(address))));
  const agentAddresses = new Set((Array.isArray(agents) ? agents : []).map((a) => cleanAddress(a?.address)).filter(Boolean));
  for (const term of terms.values()) if (term.state === "live" && isAgentTerminal(term, agentAddresses)) agentAddresses.add(term.address);
  const effective = {};
  for (const address of agentAddresses) {
    let current = address;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const group = cleanAddress(groupByAddress[current]);
      if (group && hiddenGroups.has(group) && !revealed.has(address)) {
        effective[address] = { group, inheritedFrom: current === address ? null : current };
        break;
      }
      current = cleanAddress(parentByAddress[current] ?? terms.get(current)?.parent);
    }
  }
  return effective;
}

export function withEffective(value, agents = [], terminals = [], layout = {}) {
  const state = normalizeVisibilityState(value);
  return {
    ...state,
    effective: effectiveVisibility(state, agents, terminals),
    groupEffective: groupEffectiveVisibility(state, agents, terminals, layout),
  };
}

function machineOf(address) {
  const slash = address.indexOf("/");
  return slash > 0 ? address.slice(0, slash) : null;
}

function machineUnavailable(machine, machines) {
  const list = Array.isArray(machines) ? machines : [];
  const found = list.find((m) => (m?.name ?? null) === machine);
  // A missing machine is retained: it may be a remote machine whose registry
  // has not loaded yet. The local machine is treated the same way during app
  // startup, preventing a restart from erasing a live terminal's selection.
  // Only a known ready machine proves an absent terminal ended.
  return !found || found.layout !== "ready";
}

/**
 * Remove selections only when the core proves the terminal ended. Remote
 * entries remain while their machine is loading/offline/unavailable.
 */
export function pruneEnded(value, terminals = [], machines = []) {
  const state = normalizeVisibilityState(value);
  const live = terminalMap(terminals);
  let changed = false;
  for (const address of Object.keys(state.hidden)) {
    const term = live.get(address);
    let keep;
    if (term) keep = term.state === "live" && isExplicitlyHidden(state, address, term);
    else keep = machineUnavailable(machineOf(address), machines);
    if (!keep) {
      delete state.hidden[address];
      changed = true;
    }
  }
  for (const address of Object.keys(state.revealed)) {
    const term = live.get(address);
    if (term ? term.state !== "live" || !isRevealed(state, address, term) : !machineUnavailable(machineOf(address), machines)) {
      delete state.revealed[address];
      changed = true;
    }
  }
  if (changed) {
    state.effective = {};
    state.groupEffective = {};
  }
  return state;
}

export function hiddenEntries(value, agents = [], terminals = []) {
  const state = withEffective(value, agents, terminals);
  const termMap = terminalMap(terminals);
  const agentMap = new Map((Array.isArray(agents) ? agents : []).map((a) => [a?.address, a]).filter(([address]) => address));
  const out = [];
  for (const address of Object.keys(state.effective)) {
    const info = state.effective[address];
    const explicit = isExplicitlyHidden(state, address, termMap.get(address));
    const canRestore = explicit && !info.inheritedFrom;
    out.push({ address, agent: agentMap.get(address) ?? null, inheritedFrom: info.inheritedFrom, explicit, canRestore });
  }
  return out;
}

export function hiddenGroups(value) {
  return Object.entries(normalizeVisibilityState(value).groups).map(([key, group]) => ({ key, ...group }));
}

export function actionQueue(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
