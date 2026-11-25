// Pure session state for the sidebar's agent status presentation.
// The sidebar observes its raw frame and reduces normal row clicks directly.

import { isAgentTerminal, terminalStatus as classifyTerminalStatus } from "./agent-classifier.js";
export const PRESENTATION_VERSION = 1;

const STATUSES = new Set(["blocked", "done", "working", "idle"]);
const ATTENTION = new Set(["working", "blocked"]);

export function emptyPresentationState() {
  return {
    version: PRESENTATION_VERSION,
    raw: {},
    activity: {},
    held: null,
    effective: {},
  };
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function addressOf(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusOf(value) {
  return STATUSES.has(value) ? value : "idle";
}

function reportedStatus(value) {
  if (STATUSES.has(value)) return value;
  if (!isRecord(value)) return null;
  return STATUSES.has(value.status) ? value.status : STATUSES.has(value.state) ? value.state : null;
}

function terminalStatus(term) {
  const status = classifyTerminalStatus(term);
  return status && status !== "needs-input" ? status : status === "needs-input" ? "blocked" : null;
}

function agentTerminal(term, listed = new Set()) {
  return isAgentTerminal(term, listed);
}

function terminalAgents(agents, terminals) {
  const listed = new Set((Array.isArray(agents) ? agents : []).map((agent) => addressOf(agent?.address)).filter(Boolean));
  return (Array.isArray(terminals) ? terminals : [])
    .filter((term) => (!term?.state || term.state === "live") && agentTerminal(term, listed) && !listed.has(addressOf(term?.address)))
    .map((term) => {
      const status = terminalStatus(term);
      return status ? {
        address: term.address,
        status,
        seq: term.seq ?? term.report?.seq,
        parent: term.parent,
      } : null;
    })
    .filter(Boolean);
}

function sequenceOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function machineOf(address) {
  const slash = address.indexOf("/");
  return slash > 0 ? address.slice(0, slash) : null;
}

function machineUnavailable(machine, machines) {
  const list = Array.isArray(machines) ? machines : [];
  const found = list.find((item) => (item?.name ?? null) === machine);
  return !found || found.layout !== "ready";
}

function terminalMap(terminals) {
  return new Map((Array.isArray(terminals) ? terminals : [])
    .map((term) => [addressOf(term?.address), term])
    .filter(([address]) => address));
}

function parentMap(agents, terminals) {
  const parents = {};
  for (const term of Array.isArray(terminals) ? terminals : []) {
    const address = addressOf(term?.address), parent = addressOf(term?.parent);
    if (address && parent) parents[address] = parent;
  }
  for (const agent of Array.isArray(agents) ? agents : []) {
    const address = addressOf(agent?.address), parent = addressOf(agent?.parent);
    if (address && parent) parents[address] = parent;
  }
  return parents;
}

function normalizeRaw(value) {
  const raw = {};
  for (const [address, info] of Object.entries(isRecord(value) ? value : {})) {
    const clean = addressOf(address);
    if (!clean) continue;
    raw[clean] = {
      status: statusOf(info?.status),
      seq: sequenceOf(info?.seq),
      parent: addressOf(info?.parent),
    };
  }
  return raw;
}

function normalizeActivity(value) {
  const activity = {};
  for (const [address, active] of Object.entries(isRecord(value) ? value : {})) {
    if (addressOf(address) && active === true) activity[address] = true;
  }
  return activity;
}

function normalizeHeld(value) {
  const address = addressOf(value?.address);
  if (!address) return null;
  return { address, seq: sequenceOf(value?.seq) };
}

function effectiveFrom(raw, activity, held) {
  const effective = {};
  for (const [address, info] of Object.entries(raw)) {
    const status = held?.address === address
      ? "done"
      : info.status === "idle" && !activity[address]
        ? "inactive"
        : info.status;
    effective[address] = {
      status,
      rawStatus: info.status,
      seq: held?.address === address ? held.seq : info.seq,
      active: activity[address] === true,
    };
  }
  return effective;
}

export function normalizePresentationState(value) {
  const state = emptyPresentationState();
  if (!isRecord(value)) return state;
  state.raw = normalizeRaw(value.raw);
  state.activity = normalizeActivity(value.activity);
  state.held = normalizeHeld(value.held);
  state.effective = effectiveFrom(state.raw, state.activity, state.held);
  return state;
}

/** Start a new sidebar instance: activity and the transient Done hold reset. */
export function startPresentationSession(_value) {
  return emptyPresentationState();
}

function ended(address, terms, machines) {
  const term = terms.get(address);
  if (term) return term.state != null && term.state !== "live";
  return !machineUnavailable(machineOf(address), machines);
}

function pruneEnded(state, terms, machines, present = new Set()) {
  const addresses = new Set([...Object.keys(state.raw), ...Object.keys(state.activity), ...(state.held ? [state.held.address] : [])]);
  for (const address of addresses) {
    if (present.has(address) || !ended(address, terms, machines)) continue;
    delete state.raw[address];
    delete state.activity[address];
    if (state.held?.address === address) state.held = null;
  }
  return state;
}

/**
 * Consume one render's complete raw agent snapshot. Working and blocked are
 * sticky activity for the observer session. An active descendant activates
 * every known parent without changing that parent's raw status.
 */
export function observePresentation(value, agents = [], terminals = [], machines = []) {
  const state = normalizePresentationState(value);
  const previous = state.raw;
  const parents = parentMap(agents, terminals);
  const current = {};
  const active = [];

  const observed = [...(Array.isArray(agents) ? agents : []), ...terminalAgents(agents, terminals)];
  for (const agent of observed) {
    const address = addressOf(agent?.address);
    if (!address) continue;
    const status = statusOf(agent?.status);
    const parent = addressOf(agent?.parent) ?? parents[address] ?? null;
    current[address] = { status, seq: sequenceOf(agent?.seq), parent };
    if (ATTENTION.has(status)) active.push(address);
  }
  // A terminal can be the only source of a parent relationship for a raw
  // agent. Keep that relationship in the current snapshot when present.
  for (const [address, info] of Object.entries(current)) {
    if (!info.parent) info.parent = parents[address] ?? null;
  }

  for (const address of active) {
    const seen = new Set();
    let currentAddress = address;
    while (currentAddress && !seen.has(currentAddress)) {
      seen.add(currentAddress);
      state.activity[currentAddress] = true;
      currentAddress = current[currentAddress]?.parent ?? parents[currentAddress] ?? previous[currentAddress]?.parent ?? null;
    }
  }

  state.raw = current;
  if (state.held && ATTENTION.has(current[state.held.address]?.status)) state.held = null;
  pruneEnded(state, terminalMap(terminals), machines, new Set(Object.keys(current)));
  state.effective = effectiveFrom(state.raw, state.activity, state.held);
  return state;
}

/** Apply a normal overview agent-row click before native focus runs. */
export function applyPresentationAction(value, action) {
  const state = normalizePresentationState(value);
  if (!isRecord(action) || action.type !== "overview-agent-click") return state;
  const address = addressOf(action.address);
  if (!address) return state;
  if (state.held?.address !== address) {
    state.held = statusOf(action.status) === "done"
      ? { address, seq: sequenceOf(action.seq) }
      : null;
  }
  state.effective = effectiveFrom(state.raw, state.activity, state.held);
  return state;
}

export function effectiveAgent(state, agent) {
  const address = addressOf(agent?.address);
  const info = normalizePresentationState(state).effective[address];
  return info ? { ...agent, status: info.status, seq: info.seq } : agent;
}

