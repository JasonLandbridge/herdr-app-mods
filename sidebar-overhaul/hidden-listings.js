import { normalizeVisibilityState } from "./agent-visibility.js";

export const HIDDEN_LISTINGS = "over9k.hiddenListings";
export const HIDDEN_REMOVALS = "over9k.hiddenRemovals";
const HIDDEN_LISTINGS_VERSION = 1;

const isRecord = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function path(value) {
  const result = text(value);
  if (!result) return null;
  return result.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function normalizeMachine(value) {
  return text(value);
}

function normalizeKind(value) {
  return value === "space" ? "space" : "project";
}

function normalizeKey(value) {
  return text(value);
}

function normalizeGroup(value) {
  if (!isRecord(value)) return null;
  const key = normalizeKey(value.key);
  const folder = path(value.folder);
  if (!key && !folder) return null;
  return {
    key,
    kind: normalizeKind(value.kind),
    machine: normalizeMachine(value.machine),
    folder,
  };
}

export function groupListingKey(group) {
  const normalized = normalizeGroup(group);
  if (!normalized) return null;
  return JSON.stringify([
    normalized.machine ?? null,
    normalized.kind ?? "project",
    normalized.folder ?? normalized.key,
  ]);
}

function normalizedBooleanMap(value) {
  const output = {};
  if (!isRecord(value)) return output;
  for (const [key, enabled] of Object.entries(value)) {
    const clean = text(key);
    if (clean && enabled === true) output[clean] = true;
  }
  return output;
}

export function normalizeHiddenListings(value) {
  return {
    version: HIDDEN_LISTINGS_VERSION,
    records: normalizedBooleanMap(value?.records),
    groups: normalizedBooleanMap(value?.groups),
  };
}

export function isRecordDismissed(value, recordKey) {
  const key = text(recordKey);
  return Boolean(key && value?.records && value.records[key] === true);
}

export function isGroupDismissed(value, group) {
  const key = groupListingKey(group);
  return Boolean(key && value?.groups && value.groups[key] === true);
}

function normalizeId(value) {
  const string = text(value);
  if (string) return string;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeTarget(value) {
  if (!isRecord(value)) return null;
  const address = text(value.address);
  if (!address) return null;
  return { address, created_ms: number(value.created_ms) };
}

function targetKey(target) {
  return `${target.address}\u0000${target.created_ms === null ? "null" : target.created_ms}`;
}

function normalizeRemoval(value) {
  if (!isRecord(value) || !Array.isArray(value.targets)) return null;
  const id = normalizeId(value.id);
  if (id === null) return null;
  const targets = [];
  const seenTargets = new Set();
  for (const item of value.targets) {
    const target = normalizeTarget(item);
    if (!target) continue;
    const key = targetKey(target);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    targets.push(target);
  }
  if (value.targets.length > 0 && targets.length === 0) return null;
  const recordKeys = [];
  const seenRecords = new Set();
  for (const item of Array.isArray(value.recordKeys) ? value.recordKeys : []) {
    const key = text(item);
    if (!key || seenRecords.has(key)) continue;
    seenRecords.add(key);
    recordKeys.push(key);
  }
  return {
    id,
    targets,
    recordKeys,
    group: normalizeGroup(value.group),
  };
}

function normalizedPending(value) {
  const output = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const event = normalizeRemoval(item);
    if (!event) continue;
    const id = typeof event.id === "number" ? `number:${event.id}` : `string:${event.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(event);
  }
  return output;
}

function machineOf(address) {
  const slash = address.indexOf("/");
  return slash > 0 ? address.slice(0, slash) : null;
}

function machineReady(machine, machines) {
  const found = (Array.isArray(machines) ? machines : []).find((item) => (item?.name ?? null) === machine);
  if (!found || found.layout !== "ready") return false;
  return true;
}

function terminalsAt(address, terminals) {
  return (Array.isArray(terminals) ? terminals : []).filter((item) => text(item?.address) === address);
}

function endedTarget(target, terminals, machines) {
  const matches = terminalsAt(target.address, terminals);
  if (matches.length) {
    for (const terminal of matches) {
      if (terminal?.state === "live") {
        if (target.created_ms === null) return false;
        if (number(terminal.created_ms) === target.created_ms) return false;
        if (number(terminal.created_ms) === null) return false;
      } else if (terminal?.state != null) {
        continue;
      } else {
        return false;
      }
    }
    return true;
  }
  return machineReady(machineOf(target.address), machines);
}

function eventComplete(event, terminals, machines) {
  return event.targets.every((target) => endedTarget(target, terminals, machines));
}

function hiddenMatchesTarget(address, metadata, targets) {
  if (!targets.some((target) => target.address === address)) return false;
  const created = number(metadata?.created_ms);
  return targets.some((target) => target.address === address && target.created_ms === created);
}

function clearVisibility(visibility, event) {
  let changed = false;
  const hidden = { ...visibility.hidden };
  const groups = { ...visibility.groups };
  const recordKeys = new Set(event.recordKeys);
  for (const [address, metadata] of Object.entries(hidden)) {
    if (recordKeys.has(metadata?.recordKey) || hiddenMatchesTarget(address, metadata, event.targets)) {
      delete hidden[address];
      changed = true;
    }
  }
  const groupKey = normalizeKey(event.group?.key);
  if (groupKey && own(groups, groupKey)) {
    delete groups[groupKey];
    changed = true;
  }
  if (!changed) return visibility;
  return { ...visibility, hidden, groups, effective: {}, groupEffective: {} };
}

function dismissListings(listings, event) {
  const records = { ...listings.records };
  const groups = { ...listings.groups };
  for (const key of event.recordKeys) records[key] = true;
  const group = groupListingKey(event.group);
  if (group) groups[group] = true;
  return { ...listings, records, groups };
}

export function applyHiddenRemovals({ visibility, listings, pending, terminals, machines } = {}) {
  let nextVisibility = normalizeVisibilityState(visibility);
  let nextListings = normalizeHiddenListings(listings);
  const nextPending = [];
  const events = normalizedPending(pending);
  for (const event of events) {
    if (!eventComplete(event, terminals, machines)) {
      nextPending.push(event);
      continue;
    }
    nextListings = dismissListings(nextListings, event);
    nextVisibility = clearVisibility(nextVisibility, event);
  }
  return { visibility: nextVisibility, listings: nextListings, pending: nextPending };
}
