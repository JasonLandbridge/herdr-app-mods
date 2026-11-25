// Durable agent recovery records. This module is deliberately pure so the
// sidebar and close confirmation can capture the same metadata before a
// terminal is destroyed without importing one mod at runtime.

export const RECOVERY_STATE = "over9k.recovery";
export const RECOVERY_VERSION = 1;
export const REVIVE_LABELS = Object.freeze({
  agent: "revive.agent",
  session: "revive.session",
  transcript: "revive.transcript",
  cwd: "revive.cwd",
});

const AGENT_PROGRAM = /^(claude|codex|pi|opencode|gemini|aider|amp|cursor|omp)(?:$|[-_.])/i;

const isRecord = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const slashTrim = (value) => {
  const result = text(value);
  return result ? result.replace(/\\/g, "/").replace(/\/+$/, "") || "/" : null;
};
const sessionPathValue = (value) => {
  const result = text(value);
  return result ? result.replace(/\\/g, "/") : null;
};
function foregroundInfo(term, agent) {
  if (Array.isArray(term?.foreground?.argv)) {
    const argv = term.foreground.argv;
    return { present: true, argv, program: text(argv[0])?.split(/[\\/]/).pop() ?? null };
  }
  if (Array.isArray(agent?.foreground?.argv)) {
    const argv = agent.foreground.argv;
    return { present: true, argv, program: text(argv[0])?.split(/[\\/]/).pop() ?? null };
  }
  return { present: false, argv: [], program: null };
}

function foregroundIsAgent(info) {
  return Boolean(info.present && AGENT_PROGRAM.test(info.program ?? ""));
}

function restorePathFromArgs(term, agent) {
  const foreground = foregroundInfo(term, agent);
  if (!foreground.present || !foregroundIsAgent(foreground)) return null;
  const argv = foreground.argv;
  for (let i = 0; i < argv.length; i++) {
    const value = text(argv[i]);
    if (!value) continue;
    const inline = /^(?:--restore|--resume)=(.+)$/.exec(value)?.[1];
    const next = value === "--restore" || value === "--resume" ? text(argv[i + 1]) : null;
    const path = inline ?? next;
    if (path && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) && /\.jsonl$/i.test(path)) return sessionPathValue(path);
  }
  return null;
}

export function machineForAddress(address) {
  const value = text(address);
  const slash = value?.indexOf("/") ?? -1;
  return slash > 0 ? value.slice(0, slash) : null;
}

function labelsOf(term, agent) {
  const labels = isRecord(term?.labels) ? term.labels : {};
  return isRecord(agent?.labels) ? { ...labels, ...agent.labels } : labels;
}

function terminalCreatedMs(term, fallback = null) {
  return number(term?.created_ms) ?? number(fallback);
}

/**
 * Read only the identity fields installed by Revive or explicitly supplied by
 * the core. Generic cwd/title fields are display metadata, never identity.
 */
export function sessionMetadata(term = null, agent = null, session = null) {
  const labels = labelsOf(term, agent);
  const explicit = isRecord(session) ? session : {};
  const foreground = foregroundInfo(term, agent);
  const knownNonAgent = foreground.present && !foregroundIsAgent(foreground);
  const explicitPath = sessionPathValue(explicit.sessionPath ?? explicit.path);
  const restorePath = restorePathFromArgs(term, agent);
  const labelPath = sessionPathValue(labels[REVIVE_LABELS.transcript]);
  const sessionPath = explicitPath
    ?? restorePath
    ?? (!knownNonAgent ? labelPath : null);
  // Revive labels describe the session that was previously in this terminal.
  // Once the current foreground supplies a different restore path, they must
  // not leak its old id or cwd into the current session.
  const labelsMatchPath = Boolean(labelPath && sessionPath && labelPath === sessionPath);
  const useReviveLabels = !knownNonAgent && (!explicitPath && !restorePath || labelsMatchPath);
  const sessionId = text(explicit.sessionId ?? explicit.id)
    ?? (useReviveLabels ? text(labels[REVIVE_LABELS.session]) : null);
  const explicitVerified = explicit.verified === true;
  // A pair from the exact Revive labels, or an absolute path passed to the
  // current foreground agent's --restore/--resume, is verified. A known shell
  // foreground invalidates stale agent/session labels for this live terminal.
  const reviveVerified = useReviveLabels && Boolean(labelPath && (text(labels[REVIVE_LABELS.session]) || sessionPath));
  const verified = Boolean(sessionPath && !knownNonAgent && (explicitVerified || reviveVerified || restorePath));
  const cwd = slashTrim(explicit.cwd)
    ?? (useReviveLabels ? slashTrim(labels[REVIVE_LABELS.cwd]) : null)
    ?? slashTrim(term?.cwd ?? agent?.cwd);
  return { sessionId, sessionPath, verified, cwd };
}

/**
 * Stable identity for a record. Unknown sessions use the terminal creation
 * epoch as a generation boundary; address alone is intentionally insufficient
 * because a reboot can reuse it for a different agent.
 */
export function stableRecoveryKey({ machine = null, address, sessionId = null, sessionPath = null, verified = false, terminalCreatedMs: created = null, createdMs = null } = {}) {
  const cleanAddress = text(address);
  if (!cleanAddress) return null;
  const targetMachine = text(machine) ?? machineForAddress(cleanAddress) ?? null;
  if (verified && sessionPathValue(sessionPath)) return JSON.stringify([targetMachine, "session", sessionPathValue(sessionPath)]);
  const generation = number(created) ?? number(createdMs) ?? null;
  return JSON.stringify([targetMachine, "terminal", cleanAddress, generation]);
}

function ownerMetadata(owner) {
  return {
    id: text(owner?.id),
    name: text(owner?.name),
    folder: slashTrim(owner?.folder),
  };
}

function visualMetadata(visual, owner, fallbackFolder = null) {
  const folder = slashTrim(visual?.folder ?? fallbackFolder ?? owner?.folder);
  return {
    key: text(visual?.key ?? visual?.id ?? owner?.id),
    label: text(visual?.label ?? visual?.name) ?? (folder ? folder.split("/").pop() : null),
    folder,
    machine: text(visual?.machine ?? owner?.machine) ?? null,
    kind: visual?.kind === "space" ? "space" : "project",
  };
}

function normalizeRecord(value, keyHint = null) {
  if (!isRecord(value)) return null;
  const address = text(value.address);
  if (!address) return null;
  const machine = text(value.machine) ?? machineForAddress(address);
  const key = text(value.key) ?? stableRecoveryKey({
    machine,
    address,
    sessionId: value.sessionId,
    sessionPath: value.sessionPath,
    verified: value.verified === true,
    terminalCreatedMs: value.created_ms,
  }) ?? text(keyHint);
  if (!key) return null;
  const owner = ownerMetadata(value.owner);
  const visual = visualMetadata(value.visual, { ...owner, machine }, value.cwd);
  return {
    key,
    machine,
    address,
    created_ms: number(value.created_ms),
    title: text(value.title) ?? address,
    app: text(value.app),
    cwd: slashTrim(value.cwd),
    owner,
    visual,
    sessionId: text(value.sessionId),
    sessionPath: sessionPathValue(value.sessionPath),
    verified: value.verified === true && Boolean(sessionPathValue(value.sessionPath)),
    lastSeen: number(value.lastSeen) ?? null,
  };
}

export function emptyRecoveryState() {
  return { version: RECOVERY_VERSION, records: {} };
}

export function normalizeRecoveryState(value) {
  const state = emptyRecoveryState();
  if (!isRecord(value)) return state;
  const records = isRecord(value.records) ? value.records : {};
  for (const [key, valueRecord] of Object.entries(records)) {
    const record = normalizeRecord(valueRecord, key);
    if (record) state.records[record.key] = record;
  }
  return state;
}

/**
 * Capture one agent before any close command runs. `session` is optional and
 * may carry the exact Revive labels already read by the caller.
 */
export function captureRecoveryRecord({ machine = null, address, terminal = null, agent = null, pane = null, owner = null, visual = null, session = null, lastSeen = Date.now() } = {}) {
  const cleanAddress = text(address ?? agent?.address ?? terminal?.address ?? pane?.terminal);
  if (!cleanAddress) return null;
  const metadata = sessionMetadata(terminal, agent, session);
  const targetMachine = text(machine) ?? machineForAddress(cleanAddress);
  const created_ms = terminalCreatedMs(terminal, null);
  const actualOwner = ownerMetadata(owner ?? {
    id: agent?.space ?? null,
    name: agent?.space_name ?? null,
    folder: pane?.cwd ?? metadata.cwd,
  });
  const visualGroup = visualMetadata(visual, { ...actualOwner, machine: targetMachine }, pane?.cwd ?? metadata.cwd);
  const key = stableRecoveryKey({
    machine: targetMachine,
    address: cleanAddress,
    sessionId: metadata.sessionId,
    sessionPath: metadata.sessionPath,
    verified: metadata.verified,
    terminalCreatedMs: created_ms,
  });
  if (!key) return null;
  return normalizeRecord({
    key,
    machine: targetMachine,
    address: cleanAddress,
    created_ms,
    title: text(agent?.title) ?? text(terminal?.title) ?? text(agent?.name) ?? cleanAddress,
    app: text(agent?.app) ?? text(terminal?.app) ?? text(terminal?.program?.key) ?? text(agent?.program?.key),
    cwd: pane?.cwd ?? metadata.cwd ?? terminal?.cwd ?? agent?.cwd,
    owner: actualOwner,
    visual: visualGroup,
    sessionId: metadata.sessionId,
    sessionPath: metadata.sessionPath,
    verified: metadata.verified,
    lastSeen,
  });
}

function frameGroupEntries(frame, address) {
  const groups = frame?.groups;
  const entries = groups instanceof Map ? [...groups.entries()] : Object.entries(isRecord(groups) ? groups : {});
  for (const [key, rows] of entries) {
    for (const entry of Array.isArray(rows) ? rows : []) {
      if (entry?.p?.terminal !== address && entry?.terminal !== address) continue;
      const meta = frame?.groupMeta instanceof Map ? frame.groupMeta.get(key) : frame?.groupMeta?.[key];
      return { key, entry, visual: entry.visual ?? meta ?? null };
    }
  }
  return null;
}

function stripMachine(value, machine) {
  const clean = text(value);
  const prefix = text(machine) ? `${text(machine)}/` : null;
  return clean && prefix && clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
}

function spaceForRef(spaces, ref, machine) {
  const value = text(ref);
  if (!value) return null;
  return spaces.find((space) => {
    const id = text(space?.id);
    if (!id || id === value) return Boolean(id);
    if (!machine) return false;
    const spaceMachine = text(space?.machine) ?? machineForAddress(id);
    if ((spaceMachine ?? null) !== (machine ?? null)) return false;
    return stripMachine(id, machine) === value
      || stripMachine(id, machine) === stripMachine(value, machine);
  }) ?? null;
}

function frameSpace(frame, pane, agent, address, seen = new Set()) {
  if (!address || seen.has(address)) return null;
  seen.add(address);
  const spaces = Array.isArray(frame?.sp ?? frame?.spaces) ? (frame.sp ?? frame.spaces) : [];
  const panes = Array.isArray(frame?.ps ?? frame?.panes) ? (frame.ps ?? frame.panes) : [];
  const terms = Array.isArray(frame?.terms ?? frame?.terminals) ? (frame.terms ?? frame.terminals) : [];
  const agents = Array.isArray(frame?.ag ?? frame?.agents) ? (frame.ag ?? frame.agents) : [];
  const term = terms.find((item) => item?.address === address) ?? null;
  const tabRef = pane?.tab ?? agent?.tab ?? term?.tab;
  if (tabRef) {
    const found = spaces.find((space) => (space?.tabs ?? []).some((tab) => tab?.id === tabRef));
    if (found) return found;
  }
  const machine = text(term?.machine ?? agent?.machine) ?? machineForAddress(address);
  const labels = labelsOf(term, agent);
  for (const ref of [agent?.space, labels["herdr.space"], term?.space]) {
    const found = spaceForRef(spaces, ref, machine);
    if (found) return found;
  }
  const parent = term?.parent ?? agent?.parent;
  if (parent) {
    const parentAgent = agents.find((item) => item?.address === parent) ?? null;
    const parentPane = panes.find((item) => item?.terminal === parent) ?? null;
    const found = frameSpace(frame, parentPane, parentAgent, parent, seen);
    if (found) return found;
  }
  return null;
}

function frameVisual(frame, address, owner, pane) {
  const grouped = frameGroupEntries(frame, address);
  if (grouped?.visual) return { ...grouped.visual, key: grouped.visual.key ?? grouped.key };
  if (owner) return { key: owner.id, label: owner.name, folder: owner.folder, machine: owner.machine, kind: "space" };
  return { key: null, label: null, folder: pane?.cwd ?? null, machine: machineForAddress(address), kind: "project" };
}

function isAgentTerminal(term) {
  return Boolean(term?.program?.agent || term?.agent && AGENT_PROGRAM.test(term.agent));
}

/** Capture all currently observed agents; absent agents are never removed. */
export function captureRecoveryRecords(frame = {}, now = Date.now()) {
  const terms = Array.isArray(frame.terms ?? frame.terminals) ? (frame.terms ?? frame.terminals) : [];
  const termMap = new Map(terms.map((term) => [term?.address, term]).filter(([address]) => address));
  const panes = Array.isArray(frame.ps ?? frame.panes) ? (frame.ps ?? frame.panes).filter((pane) => pane?.terminal) : [];
  const paneMap = new Map(panes.map((pane) => [pane.terminal, pane]));
  const agents = Array.isArray(frame.ag ?? frame.agents) ? frame.ag ?? frame.agents : [];
  const candidates = new Map();
  for (const agent of agents) if (agent?.address) candidates.set(agent.address, agent);
  for (const term of terms) if (term?.address && isAgentTerminal(term)) candidates.set(term.address, candidates.get(term.address) ?? term);
  const out = [];
  for (const [address, agent] of candidates) {
    const terminal = termMap.get(address) ?? null;
    const pane = paneMap.get(address) ?? panes.find((item) => item.terminal === address) ?? null;
    const owner = frameSpace(frame, pane, agent, address);
    const ownerData = owner ? { id: owner.id, name: owner.name, folder: owner.folder, machine: owner.machine ?? machineForAddress(address) } : null;
    const visual = frameVisual(frame, address, ownerData, pane);
    const record = captureRecoveryRecord({
      machine: owner?.machine ?? machineForAddress(address),
      address,
      terminal,
      agent,
      pane,
      owner: ownerData,
      visual,
      lastSeen: now,
    });
    if (record) out.push(record);
  }
  return out;
}

function mergeRecord(previous, next) {
  if (!previous) return next;
  const owner = Object.fromEntries(["id", "name", "folder"].map((key) => [key, next.owner?.[key] ?? previous.owner?.[key] ?? null]));
  const visual = Object.fromEntries(["key", "label", "folder", "machine", "kind"].map((key) => [key, next.visual?.[key] ?? previous.visual?.[key] ?? null]));
  const merged = normalizeRecord({
    ...previous,
    ...next,
    created_ms: next.created_ms ?? previous.created_ms ?? null,
    title: text(next.title) ?? previous.title,
    app: text(next.app) ?? previous.app,
    cwd: slashTrim(next.cwd) ?? previous.cwd,
    owner,
    visual,
    sessionId: next.sessionId ?? previous.sessionId,
    sessionPath: next.sessionPath ?? previous.sessionPath,
    verified: next.verified === true || previous.verified === true,
    lastSeen: next.lastSeen ?? previous.lastSeen,
  });
  const sameSnapshot = JSON.stringify({ ...previous, lastSeen: null }) === JSON.stringify({ ...merged, lastSeen: null });
  return sameSnapshot ? { ...merged, lastSeen: previous.lastSeen } : merged;
}

function sameIncarnation(previous, next) {
  return previous?.machine === next?.machine
    && previous?.address === next?.address
    && previous?.created_ms != null
    && next?.created_ms != null
    && previous.created_ms === next.created_ms;
}

function sameVerifiedSession(previous, next) {
  return previous?.verified === true
    && next?.verified === true
    && previous?.machine === next?.machine
    && previous?.sessionPath === next?.sessionPath
    && Boolean(next?.sessionPath);
}

function mergeableRecord(previous, next) {
  if (!previous) return false;
  if (sameVerifiedSession(previous, next)) return true;
  if (sameIncarnation(previous, next)) {
    // Losing current identity (for example, an agent becoming a shell) must
    // not refresh a prior verified session with stale unknown metadata.
    return previous.verified !== true;
  }
  // Without a generation marker, an address cannot prove that it is the same
  // terminal. An exact unknown key can still receive ordinary same-snapshot
  // updates; cross-key enrichment is intentionally refused.
  return previous.verified !== true
    && next.verified !== true
    && previous.machine === next.machine
    && previous.address === next.address
    && previous.created_ms == null
    && next.created_ms == null
    && previous.key === next.key;
}

export function mergeRecoveryState(value, records = []) {
  const state = normalizeRecoveryState(value);
  for (const candidate of Array.isArray(records) ? records : [records]) {
    const record = normalizeRecord(candidate);
    if (!record) continue;
    let previousKey = record.key;
    // A newly verified record may be an enrichment of an older address-only
    // record, but only the same machine/address incarnation can establish that.
    if (!state.records[previousKey] && record.created_ms != null) {
      previousKey = Object.keys(state.records).find((key) => sameIncarnation(state.records[key], record)) ?? record.key;
    }
    const previous = state.records[previousKey];
    if (mergeableRecord(previous, record)) {
      state.records[record.key] = mergeRecord(previous, record);
      if (previousKey !== record.key) delete state.records[previousKey];
    } else {
      state.records[record.key] = record;
    }
  }
  return state;
}

export function recoveryRecords(value) {
  return Object.values(normalizeRecoveryState(value).records).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.key.localeCompare(b.key));
}

/** Match a live terminal only by an explicitly verified session identity. */
export function verifiedRecoveryMatch(record, { terminal = null, agent = null, machine = null } = {}) {
  const candidate = normalizeRecord(record);
  if (!candidate?.verified) return false;
  const current = sessionMetadata(terminal, agent);
  if (!current.verified || !current.sessionPath || current.sessionPath !== candidate.sessionPath) return false;
  const liveAddress = terminal?.address ?? agent?.address;
  const targetMachine = text(machine) ?? machineForAddress(liveAddress);
  if ((targetMachine ?? null) !== (candidate.machine ?? null)) return false;
  const candidateSessionId = text(candidate.sessionId);
  const currentSessionId = text(current.sessionId);
  return !candidateSessionId || !currentSessionId || candidateSessionId === currentSessionId;
}

export function findVerifiedRecoveryRecord(value, live = []) {
  const records = recoveryRecords(value);
  for (const item of Array.isArray(live) ? live : [live]) {
    const record = records.find((candidate) => verifiedRecoveryMatch(candidate, item));
    if (record) return { record, live: item };
  }
  return null;
}

/** Map only verified records; no cwd or title matching is performed. */
export function remapVerifiedRecovery(value, live = []) {
  const records = recoveryRecords(value);
  const out = [];
  for (const item of Array.isArray(live) ? live : [live]) {
    const record = records.find((candidate) => verifiedRecoveryMatch(candidate, item));
    if (record) out.push({ record, live: item });
  }
  return out;
}

export function recordForAddress(value, address) {
  const clean = text(address);
  return recoveryRecords(value).find((record) => record.address === clean) ?? null;
}
