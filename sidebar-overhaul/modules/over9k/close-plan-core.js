const AGENT_PROGRAM = /^(claude|codex|pi|opencode|gemini|aider|amp|cursor|omp)(?:$|[-_.])/i;
const STATUS = new Set(["working", "blocked", "idle", "done"]);
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

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
const list = (value) => Array.isArray(value) ? value : [];
const entries = (value) => value instanceof Map ? [...value.entries()] : Object.entries(isRecord(value) ? value : {});
function identityText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identityNumber(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function identityPane(value) {
  return {
    pane: identityText(value?.pane),
    terminal: identityText(value?.terminal),
    tab: identityText(value?.tab),
    cwd: identityText(value?.cwd),
  };
}

function identityTerminal(value) {
  return {
    address: identityText(value?.address),
    created_ms: identityNumber(value?.created_ms ?? value?.createdAt ?? value?.created_at ?? value?.started_at),
    parent: identityText(value?.parent),
    cwd: identityText(value?.cwd),
    foreground: { cwd: identityText(value?.foreground?.cwd) },
  };
}

export function visualSnapshotIdentity({ panes = [], terminals = [] } = {}) {
  const paneIdentity = list(panes).map(identityPane).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const terminalIdentity = list(terminals).map(identityTerminal).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ panes: paneIdentity, terminals: terminalIdentity });
}
const machineForAddress = (address) => {
  const value = text(address);
  const slash = value?.indexOf("/") ?? -1;
  return slash > 0 ? value.slice(0, slash) : null;
};
const normalizeMachine = (value, address = null) => text(value) ?? machineForAddress(address);
const sameMachine = (left, right) => (left ?? null) === (right ?? null);
const normalizeId = (value) => text(value);
const stripMachine = (id, machine) => {
  const value = text(id);
  if (!value) return null;
  const prefix = machine ? `${machine}/` : null;
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
};
const inside = (folder, parent) => {
  const child = slashTrim(folder), base = slashTrim(parent);
  return Boolean(child && base && (child === base || base === "/" || child.startsWith(`${base}/`)));
};
const terminalLike = (term) => Boolean(term?.program?.agent || AGENT_PROGRAM.test(term?.agent ?? "") || AGENT_PROGRAM.test(term?.program?.key ?? ""));
const statusOf = (agent, term) => {
  const value = agent?.status ?? term?.status ?? term?.report?.status ?? term?.report?.state;
  return STATUS.has(value) ? value : terminalLike(term) ? "idle" : null;
};

function labelsOf(term, agent) {
  const labels = isRecord(term?.labels) ? term.labels : {};
  return isRecord(agent?.labels) ? { ...labels, ...agent.labels } : labels;
}

function foregroundInfo(term, agent) {
  if (Array.isArray(term?.foreground?.argv)) return { argv: term.foreground.argv, present: true };
  if (Array.isArray(agent?.foreground?.argv)) return { argv: agent.foreground.argv, present: true };
  return { argv: [], present: false };
}

function foregroundIsAgent(argv) {
  const executable = text(argv?.[0])?.replace(/\\/g, "/").split("/").pop();
  return Boolean(executable && AGENT_PROGRAM.test(executable));
}

function restorePathFromArgs(argv) {
  const values = list(argv);
  for (let i = 0; i < values.length; i++) {
    const value = text(values[i]);
    if (!value) continue;
    const inline = /^(?:--restore|--resume)=(.+)$/.exec(value)?.[1];
    const next = value === "--restore" || value === "--resume" ? text(values[i + 1]) : null;
    const path = inline ?? next;
    if (path && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) && /\.jsonl$/i.test(path)) return sessionPathValue(path);
  }
  return null;
}

function sessionMetadata(term = null, agent = null, session = null) {
  const labels = labelsOf(term, agent);
  const explicit = isRecord(session) ? session : {};
  const foreground = foregroundInfo(term, agent);
  const ambientAllowed = !foreground.present || foregroundIsAgent(foreground.argv);
  const sessionId = text(explicit.sessionId ?? explicit.id)
    ?? (ambientAllowed ? text(labels["revive.session"]) : null)
    ?? (ambientAllowed ? text(term?.sessionId ?? term?.session_id ?? agent?.sessionId ?? agent?.session_id) : null);
  const restorePath = ambientAllowed ? restorePathFromArgs(foreground.argv) : null;
  const sessionPath = sessionPathValue(explicit.sessionPath ?? explicit.path)
    ?? restorePath
    ?? (ambientAllowed ? sessionPathValue(labels["revive.transcript"]) : null)
    ?? (ambientAllowed ? sessionPathValue(term?.sessionPath ?? term?.session_path ?? agent?.sessionPath ?? agent?.session_path) : null);
  const explicitVerified = explicit.verified === true;
  const reviveVerified = ambientAllowed && Boolean(text(labels["revive.transcript"]) && (text(labels["revive.session"]) || sessionPath));
  const verified = Boolean(sessionPath && (explicitVerified || reviveVerified || restorePath));
  const cwd = slashTrim(explicit.cwd)
    ?? (ambientAllowed ? slashTrim(labels["revive.cwd"]) : null)
    ?? slashTrim(term?.cwd ?? agent?.cwd);
  return { sessionId, sessionPath, verified, cwd };
}

function terminalCreatedMs(term) {
  return number(term?.created_ms ?? term?.createdAt ?? term?.created_at ?? term?.started_at);
}

function stableRecoveryKey({ machine = null, address, sessionPath = null, verified = false, terminalCreatedMs: created = null } = {}) {
  const cleanAddress = text(address);
  if (!cleanAddress) return null;
  const targetMachine = normalizeMachine(machine, cleanAddress);
  if (verified && sessionPathValue(sessionPath)) return JSON.stringify([targetMachine, "session", sessionPathValue(sessionPath)]);
  return JSON.stringify([targetMachine, "terminal", cleanAddress, number(created)]);
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
    machine: normalizeMachine(visual?.machine, null) ?? normalizeMachine(owner?.machine, null),
    kind: visual?.kind === "space" ? "space" : "project",
  };
}

function normalizeRecord(value, keyHint = null) {
  if (!isRecord(value)) return null;
  const address = text(value.address);
  if (!address) return null;
  const machine = normalizeMachine(value.machine, address);
  const created_ms = number(value.created_ms);
  const key = text(value.key) ?? stableRecoveryKey({
    machine,
    address,
    sessionPath: value.sessionPath,
    verified: value.verified === true,
    terminalCreatedMs: created_ms,
  }) ?? text(keyHint);
  if (!key) return null;
  const owner = ownerMetadata(value.owner);
  const visual = visualMetadata(value.visual, { ...owner, machine }, value.cwd);
  return {
    key,
    machine,
    address,
    created_ms,
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

export function captureRecoveryRecord({ machine = null, address, terminal = null, agent = null, pane = null, owner = null, visual = null, session = null, lastSeen = Date.now() } = {}) {
  const cleanAddress = text(address ?? agent?.address ?? terminal?.address ?? pane?.terminal);
  if (!cleanAddress) return null;
  const metadata = sessionMetadata(terminal, agent, session);
  const targetMachine = normalizeMachine(machine, cleanAddress);
  const created_ms = terminalCreatedMs(terminal);
  const actualOwner = ownerMetadata(owner ?? {
    id: agent?.space ?? null,
    name: agent?.space_name ?? null,
    folder: pane?.cwd ?? metadata.cwd,
  });
  const visualGroup = visualMetadata(visual, { ...actualOwner, machine: targetMachine }, pane?.cwd ?? metadata.cwd);
  const key = stableRecoveryKey({
    machine: targetMachine,
    address: cleanAddress,
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

function normalizeRecoveryState(value) {
  const state = { version: 1, records: {} };
  if (!isRecord(value)) return state;
  for (const [key, candidate] of Object.entries(isRecord(value.records) ? value.records : {})) {
    const record = normalizeRecord(candidate, key);
    if (record) state.records[record.key] = record;
  }
  return state;
}

function mergeRecord(previous, next) {
  if (!previous) return next;
  return normalizeRecord({
    ...previous,
    ...next,
    created_ms: next.created_ms ?? previous.created_ms,
    title: text(next.title) ?? previous.title,
    app: text(next.app) ?? previous.app,
    cwd: slashTrim(next.cwd) ?? previous.cwd,
    owner: { ...previous.owner, ...next.owner },
    visual: { ...previous.visual, ...next.visual },
    sessionId: next.sessionId ?? previous.sessionId,
    sessionPath: next.sessionPath ?? previous.sessionPath,
    verified: next.verified === true || previous.verified === true,
    lastSeen: Math.max(previous.lastSeen ?? 0, next.lastSeen ?? 0) || null,
  });
}

export function mergeRecoveryState(value, records = []) {
  const state = normalizeRecoveryState(value);
  for (const candidate of (Array.isArray(records) ? records : [records])) {
    const record = normalizeRecord(candidate);
    if (!record) continue;
    let previousKey = record.key;
    if (!state.records[previousKey] && record.created_ms != null) {
      previousKey = Object.keys(state.records).find((key) => {
        const previous = state.records[key];
        return previous?.machine === record.machine && previous?.address === record.address && previous.created_ms === record.created_ms;
      }) ?? record.key;
    }
    const previous = state.records[previousKey];
    const sameIncarnation = record.created_ms != null
      && previous?.machine === record.machine
      && previous?.address === record.address
      && previous.created_ms === record.created_ms;
    state.records[record.key] = sameIncarnation ? mergeRecord(previous, record) : record;
    if (previousKey !== record.key) delete state.records[previousKey];
  }
  return state;
}


function mapSpaces(spaces) {
  const byId = new Map();
  const byTab = new Map();
  for (const space of list(spaces)) {
    if (!space?.id) continue;
    byId.set(space.id, space);
    for (const tab of list(space.tabs)) if (tab?.id) byTab.set(tab.id, space);
  }
  return { byId, byTab };
}

function labelsFor(term, agent) {
  return labelsOf(term, agent);
}

function findSpaceByRef(ref, machine, spaces) {
  const value = text(ref);
  if (!value) return null;
  return list(spaces).find((space) => {
    if (!sameMachine(space.machine, machine)) return false;
    return space.id === value || stripMachine(space.id, machine) === value || stripMachine(value, machine) === stripMachine(space.id, machine);
  }) ?? null;
}

function findTab(space, ref) {
  const value = text(ref);
  if (!value || !space) return null;
  return list(space.tabs).find((tab) => tab.id === value || stripMachine(tab.id, space.machine) === value || stripMachine(value, space.machine) === stripMachine(tab.id, space.machine)) ?? null;
}

function ownerForAddress(address, maps, terminalsByAddress, agentsByAddress, seen = new Set()) {
  if (!address || seen.has(address)) return { space: null, tab: null };
  seen.add(address);
  const pane = maps.paneByAddress.get(address);
  if (pane?.tab) {
    const space = maps.byTab.get(pane.tab) ?? null;
    return { space, tab: space ? findTab(space, pane.tab) ?? { id: pane.tab } : { id: pane.tab } };
  }
  const term = terminalsByAddress.get(address);
  const agent = agentsByAddress.get(address);
  const machine = normalizeMachine(term?.machine ?? agent?.machine, address);
  const labels = labelsFor(term, agent);
  const labeledSpace = findSpaceByRef(labels["herdr.space"] ?? term?.space ?? agent?.space, machine, maps.spaces);
  if (labeledSpace) {
    const tab = findTab(labeledSpace, labels["herdr.tab"] ?? term?.tab ?? agent?.tab);
    return { space: labeledSpace, tab };
  }
  const parent = term?.parent ?? agent?.parent;
  if (parent) return ownerForAddress(parent, maps, terminalsByAddress, agentsByAddress, seen);
  return { space: null, tab: null };
}

function ownerData(space) {
  return space ? { id: space.id, name: space.name, folder: space.folder, machine: space.machine ?? null } : null;
}

function visualEntry(snapshot, address, pane, owner) {
  const groups = entries(snapshot.groups);
  for (const [key, rows] of groups) {
    for (const entry of list(rows)) {
      if (entry?.p?.terminal === address || entry?.p?.pane === pane?.pane || entry?.terminal === address) {
        const visual = entry.visual ?? (snapshot.groupMeta instanceof Map ? snapshot.groupMeta.get(key) : snapshot.groupMeta?.[key]);
        if (visual) return { ...visual, key: visual.key ?? key };
      }
    }
  }
  const visualGroups = snapshot.visualGroups;
  const direct = visualGroups instanceof Map ? visualGroups.get(address) ?? visualGroups.get(pane?.pane) : visualGroups?.[address] ?? visualGroups?.[pane?.pane];
  if (direct) return direct;
  const terminals = list(snapshot.terminals ?? snapshot.terms);
  const cwd = slashTrim(pane?.cwd ?? terminals.find((term) => term.address === address)?.cwd);
  const machine = owner?.machine ?? machineForAddress(address);
  const candidates = [];
  for (const space of list(snapshot.spaces ?? snapshot.sp)) {
    if (sameMachine(space.machine, machine) && inside(cwd, space.folder)) candidates.push({ key: space.id, label: space.name, folder: space.folder, machine: space.machine ?? null, kind: "space", length: slashTrim(space.folder)?.length ?? 0 });
  }
  for (const project of list(snapshot.projects)) {
    const folder = typeof project === "string" ? project : project?.folder;
    const projectMachine = typeof project === "string" ? machine : project?.machine ?? machine;
    if (sameMachine(projectMachine, machine) && inside(cwd, folder)) {
      const clean = slashTrim(folder);
      candidates.push({ key: `${machine ? `r:${machine}:` : "d:"}${clean}`, label: text(project?.label ?? project?.name) ?? clean?.split("/").pop(), folder: clean, machine, kind: "project", length: clean?.length ?? 0 });
    }
  }
  candidates.sort((a, b) => b.length - a.length || (a.kind === "space" ? -1 : 1));
  if (candidates[0]) {
    const { length, ...group } = candidates[0];
    return group;
  }
  if (cwd && owner && inside(cwd, owner.folder)) return { key: owner.id, label: owner.name, folder: owner.folder, machine: owner.machine ?? null, kind: "space" };
  if (cwd) {
    const label = cwd.split("/").pop() || cwd;
    return { key: `${machine ? `r:${machine}:` : "d:"}${cwd}`, label, folder: cwd, machine, kind: "project" };
  }
  if (owner) return { key: owner.id, label: owner.name, folder: owner.folder, machine: owner.machine ?? null, kind: "space" };
  return { key: null, label: null, folder: null, machine, kind: "project" };
}

function existingVisual(snapshot, address, machine, metadata, created_ms) {
  const records = snapshot.recovery?.records;
  if (created_ms == null) return null;
  for (const record of Object.values(isRecord(records) ? records : {})) {
    if (record?.address !== address || !sameMachine(record.machine, machine) || record.created_ms !== created_ms) continue;
    if (metadata.verified && record.verified && record.sessionPath === metadata.sessionPath) return record.visual;
    if (!metadata.verified && !record.verified) return record.visual;
  }
  return null;
}

function makeRecord(snapshot, address, pane, owner, term, agent, now) {
  const metadata = sessionMetadata(term, agent);
  const created_ms = terminalCreatedMs(term);
  const visual = existingVisual(snapshot, address, owner?.machine ?? machineForAddress(address), metadata, created_ms) ?? visualEntry(snapshot, address, pane, owner);
  return captureRecoveryRecord({
    machine: owner?.machine ?? machineForAddress(address),
    address,
    terminal: term,
    agent,
    pane,
    owner: ownerData(owner),
    visual,
    lastSeen: now,
  });
}


function snapshotParts(snapshot = {}) {
  const spaces = list(snapshot.spaces ?? snapshot.sp);
  const panes = list(snapshot.panes ?? snapshot.ps);
  const agents = list(snapshot.agents ?? snapshot.ag);
  const terminals = list(snapshot.terminals ?? snapshot.terms);
  const terminalsByAddress = new Map(terminals.map((term) => [term?.address, term]).filter(([address]) => address));
  const agentsByAddress = new Map(agents.map((agent) => [agent?.address, agent]).filter(([address]) => address));
  for (const term of terminals) if (term?.address && terminalLike(term) && !agentsByAddress.has(term.address)) agentsByAddress.set(term.address, term);
  const { byId: spaceById, byTab } = mapSpaces(spaces);
  const paneById = new Map(panes.map((pane) => [pane?.pane, pane]).filter(([id]) => id));
  const paneByAddress = new Map(panes.filter((pane) => pane?.terminal).map((pane) => [pane.terminal, pane]));
  const recovery = normalizeRecoveryState(snapshot.recovery);
  const hiddenListings = snapshot.hiddenListings;
  return { spaces, panes, agents, terminals, terminalsByAddress, agentsByAddress, spaceById, byTab, paneById, paneByAddress, recovery, hiddenListings, recoveryRecords: Object.values(recovery.records) };
}

function normalizeSubs(p) {
  return list(p?.subs ?? p?.subRows).filter((item) => isRecord(item)).map((item) => ({ ...item }));
}

function commandKey(command) {
  return `${command.name}:${JSON.stringify(command.args ?? {})}`;
}

function addRootAddress(roots, value, terminalMap, agentMap = null) {
  const address = text(value);
  if (address && (terminalMap.has(address) || agentMap?.has(address) || !terminalMap.size)) roots.add(address);
}


function selectedTarget(p, parts) {
  const S = new Set(list(p?.spaces).filter((id) => parts.spaceById.has(id)));
  const T = new Set(list(p?.tabs).filter((id) => parts.byTab.has(id) && !S.has(parts.byTab.get(id)?.id)));
  const explicitPanes = new Set(list(p?.panes).filter((id) => parts.paneById.has(id)));
  const roots = new Set();
  const paneIds = new Set(explicitPanes);
  for (const spaceId of S) {
    const space = parts.spaceById.get(spaceId);
    for (const tab of list(space?.tabs)) for (const pane of parts.panes.filter((item) => item.tab === tab.id)) {
      paneIds.add(pane.pane);
      addRootAddress(roots, pane.terminal, parts.terminalsByAddress, parts.agentsByAddress);
    }
    for (const term of [...parts.terminals, ...parts.agents]) {
      const owner = ownerForAddress(term?.address, parts, parts.terminalsByAddress, parts.agentsByAddress);
      if (owner.space?.id === spaceId) addRootAddress(roots, term.address, parts.terminalsByAddress, parts.agentsByAddress);
    }
  }
  for (const tabId of T) {
    for (const pane of parts.panes.filter((item) => item.tab === tabId)) {
      paneIds.add(pane.pane);
      addRootAddress(roots, pane.terminal, parts.terminalsByAddress, parts.agentsByAddress);
    }
    for (const term of [...parts.terminals, ...parts.agents]) {
      const owner = ownerForAddress(term?.address, parts, parts.terminalsByAddress, parts.agentsByAddress);
      if (owner.tab?.id === tabId) addRootAddress(roots, term.address, parts.terminalsByAddress, parts.agentsByAddress);
    }
  }
  for (const paneId of explicitPanes) addRootAddress(roots, parts.paneById.get(paneId)?.terminal, parts.terminalsByAddress, parts.agentsByAddress);
  for (const address of list(p?.terminals ?? p?.addresses ?? p?.agents)) addRootAddress(roots, address?.address ?? address, parts.terminalsByAddress, parts.agentsByAddress);
  const subs = normalizeSubs(p);
  for (const item of subs) {
    if (item.kind === "terminal") addRootAddress(roots, item.terminal ?? item.address, parts.terminalsByAddress, parts.agentsByAddress);
    if (item.agent) addRootAddress(roots, item.agent, parts.terminalsByAddress, parts.agentsByAddress);
  }
  return { S, T, explicitPanes, paneIds, roots, subs };
}

function expandDescendants(roots, parts) {
  const affected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of [...parts.terminals, ...parts.agents]) {
      if (!item?.address || affected.has(item.address) || !item.parent || !affected.has(item.parent)) continue;
      affected.add(item.address);
      changed = true;
    }
  }
  return affected;
}

function ownerForAffected(address, parts) {
  const result = ownerForAddress(address, parts, parts.terminalsByAddress, parts.agentsByAddress);
  return result;
}

function agentRecordsFor(affected, parts, snapshot, now) {
  const records = [];
  const details = [];
  const seen = new Set();
  for (const address of affected) {
    const agent = parts.agentsByAddress.get(address);
    const term = parts.terminalsByAddress.get(address);
    if (!agent && !terminalLike(term)) continue;
    const pane = parts.paneByAddress.get(address) ?? null;
    const owner = ownerForAffected(address, parts).space;
    const record = makeRecord(snapshot, address, pane, owner, term, agent, now);
    if (!record || seen.has(record.key)) continue;
    seen.add(record.key);
    records.push(record);
    const tab = ownerForAffected(address, parts).tab;
    details.push({ address, status: statusOf(agent, term), pane: pane?.pane ?? null, tab: tab?.id ?? pane?.tab ?? null, machine: record.machine, key: record.key, owner: record.owner, visual: record.visual });
  }
  return { records, details };
}

function subAgentAddresses(subs, parts) {
  return new Set(subs.flatMap((item) => item.agent ? [item.agent] : []));
}
function epochOf(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function terminalEpoch(term) {
  return epochOf(term?.created_ms ?? term?.createdAt ?? term?.created_at ?? term?.started_at);
}

const ENDED_STATES = new Set(["closed", "dead", "ended", "exited", "stopped", "terminated"]);
function terminalEnded(term) {
  return Boolean(term && (term.live === false || term.ended === true || ENDED_STATES.has(String(term.state ?? "").toLowerCase())));
}

function terminalLive(term) {
  return Boolean(term?.address) && !terminalEnded(term);
}

function normalizeHiddenGroup(value) {
  if (!isRecord(value)) return null;
  return {
    key: text(value.key),
    kind: value.kind === "space" ? "space" : "project",
    machine: text(value.machine),
    folder: slashTrim(value.folder),
  };
}

function groupMetadataMatches(left, right) {
  if (!left || !right || (left.kind ?? "project") !== (right.kind ?? "project")) return false;
  if (!sameMachine(left.machine, right.machine)) return false;
  const leftFolder = slashTrim(left.folder), rightFolder = slashTrim(right.folder);
  return Boolean(leftFolder && rightFolder && leftFolder === rightFolder);
}

function groupMatches(left, right) {
  const target = normalizeHiddenGroup(right);
  if (!target || !left) return false;
  const candidate = { ...left, kind: left.kind === "space" ? "space" : "project", folder: slashTrim(left.folder), machine: text(left.machine), key: text(left.key) };
  if (target.key && candidate.key) {
    const foldersMatch = !target.folder || !candidate.folder || target.folder === candidate.folder;
    return target.key === candidate.key && foldersMatch && (candidate.kind === target.kind) && sameMachine(candidate.machine, target.machine);
  }
  return groupMetadataMatches(candidate, target);
}

function projectionFor(snapshot) {
  const value = snapshot?.visualGroups;
  if (!isRecord(value) || value.version !== 1 || typeof value.identity !== "string" || !Array.isArray(value.groups)) {
    return { valid: false, groups: [], error: "The visual group snapshot is unavailable. Review the hidden group after the sidebar reconnects." };
  }
  if (value.identity !== visualSnapshotIdentity(snapshot)) {
    return { valid: false, groups: [], error: "The visual group snapshot is stale. Review the hidden group again before closing it." };
  }
  return {
    valid: true,
    groups: value.groups.filter(isRecord).map((group) => ({
      ...normalizeHiddenGroup(group),
      label: text(group.label),
      members: list(group.members).map((member) => ({ address: text(member?.address), created_ms: epochOf(member?.created_ms) })).filter((member) => member.address),
    })),
    error: null,
  };
}

function projectionGroupExact(candidate, group) {
  return Boolean(candidate && group?.key
    && text(candidate.key) === group.key
    && (candidate.kind ?? "project") === (group.kind ?? "project")
    && sameMachine(candidate.machine, group.machine)
    && (!group.folder || !candidate.folder || slashTrim(candidate.folder) === slashTrim(group.folder)));
}

function projectionGroupsFor(projection, group) {
  const exact = group?.key ? projection.groups.filter((candidate) => projectionGroupExact(candidate, group)) : [];
  return exact.length ? exact : projection.groups.filter((candidate) => groupMetadataMatches(candidate, group));
}

function memberMatchesTerminal(member, term) {
  return Boolean(member?.address && term?.address && member.address === term.address
    && member.created_ms != null && terminalEpoch(term) != null && member.created_ms === terminalEpoch(term));
}

function recordMatchesTerminal(record, address, term, agent) {
  if (!record || !address || record.address !== address || !term) return false;
  if (!sameMachine(record.machine, normalizeMachine(term.machine ?? agent?.machine, address))) return false;
  if (record.created_ms != null) return terminalEpoch(term) != null && record.created_ms === terminalEpoch(term);
  const metadata = sessionMetadata(term, agent);
  return Boolean(record.verified && metadata.verified && record.sessionPath && record.sessionPath === metadata.sessionPath);
}

function recoveryRecordFor(parts, address, term, agent) {
  return parts.recoveryRecords.find((record) => recordMatchesTerminal(record, address, term, agent)) ?? null;
}

function machineReady(snapshot, machine) {
  const target = machine ?? null;
  return list(snapshot?.machines).some((item) => (item?.name ?? null) === target && item?.layout === "ready");
}

function reconnectError(machine) {
  return `Reconnect to ${machine ?? "this computer"} and wait for its terminal layout before removing this hidden entry.`;
}

function visibilityGroupFor(snapshot, address) {
  const visibility = snapshot?.visibility;
  const info = visibility?.groupEffective?.[address];
  const key = text(info?.group ?? info);
  if (!key) return null;
  const metadata = visibility?.groups?.[key];
  return { key, ...(isRecord(metadata) ? metadata : {}) };
}

function hiddenVisualFor(snapshot, parts, address, term, agent, fallbackGroup = null) {
  const mapped = visibilityGroupFor(snapshot, address);
  if (mapped) return mapped;
  const existing = recoveryRecordFor(parts, address, term, agent);
  if (existing?.visual) return existing.visual;
  const pane = parts.paneByAddress.get(address) ?? null;
  const owner = ownerForAffected(address, parts).space;
  return fallbackGroup ?? visualEntry(snapshot, address, pane, owner);
}

function hiddenRecordFor(snapshot, parts, address, term, agent, group, now) {
  const existing = recoveryRecordFor(parts, address, term, agent);
  if (existing) return existing;
  const pane = parts.paneByAddress.get(address) ?? null;
  const owner = ownerForAffected(address, parts).space;
  return captureRecoveryRecord({
    machine: normalizeMachine(term?.machine ?? agent?.machine, address),
    address,
    terminal: term,
    agent,
    pane,
    owner: ownerData(owner),
    visual: group ?? hiddenVisualFor(snapshot, parts, address, term, agent),
    lastSeen: now,
  });
}

function pendingHiddenRemovalIdentity(value) {
  return list(value).filter(isRecord).map((event) => ({
    id: text(event.id),
    targets: list(event.targets).map((target) => ({ address: text(target?.address), created_ms: epochOf(target?.created_ms) })).filter((target) => target.address),
    recordKeys: [...new Set(list(event.recordKeys).map(text).filter(Boolean))].sort(),
    group: normalizeHiddenGroup(event.group),
  })).filter((event) => event.id || event.targets.length || event.recordKeys.length || event.group);
}


function hiddenClosePlan(hidden, snapshot, parts) {
  const now = Number.isFinite(Number(snapshot.now)) ? Number(snapshot.now) : Date.now();
  const isGroup = hidden?.kind === "group" || isRecord(hidden?.group);
  const group = isGroup ? normalizeHiddenGroup(hidden.group ?? hidden) : null;
  const label = text(hidden?.group?.label ?? hidden?.label);
  const roots = new Set();
  const saved = new Map();
  const endedTargets = new Map();
  const blockedErrors = [];
  const addSaved = (record) => { if (record?.key) saved.set(record.key, record); };
  const addEndedTarget = (address, created_ms) => {
    if (address && created_ms != null) endedTargets.set(`${address}:${created_ms}`, { address, created_ms });
  };

  if (isGroup) {
    if (!group || (!group.key && !group.folder)) blockedErrors.push("The hidden group identity is unavailable. Review the sidebar and try again.");
    const projection = group ? projectionFor(snapshot) : { valid: false, groups: [], error: null };
    if (!projection.valid && projection.error) blockedErrors.push(projection.error);
    const matchingGroups = projection.valid ? projectionGroupsFor(projection, group) : [];
    const exactProjection = Boolean(projection.valid && group?.key && matchingGroups.length > 0
      && matchingGroups.some((candidate) => text(candidate.key) === group.key));
    if (projection.valid && matchingGroups.length > 1) {
      blockedErrors.push("The hidden group identity is ambiguous. Review the sidebar and try again.");
    }
    for (const member of matchingGroups.length === 1 ? matchingGroups[0].members : []) {
      const term = parts.terminalsByAddress.get(member.address);
      if (!term) continue;
      if (memberMatchesTerminal(member, term)) {
        if (terminalLive(term)) roots.add(member.address);
        else addEndedTarget(member.address, member.created_ms);
      } else if (terminalLive(term)) {
        blockedErrors.push(`The visual member ${member.address} changed identity. Review the hidden group and try again.`);
      }
    }
    for (const record of parts.recoveryRecords) {
      const recordGroupMatches = exactProjection ? groupMatches(record.visual, group) : groupMetadataMatches(record.visual, group);
      if (!recordGroupMatches) continue;
      addSaved(record);
      const term = parts.terminalsByAddress.get(record.address);
      const agent = parts.agentsByAddress.get(record.address);
      if (term && recordMatchesTerminal(record, record.address, term, agent)) {
        if (terminalLive(term)) roots.add(record.address);
        else addEndedTarget(record.address, record.created_ms);
      }
    }
  } else {
    const requestedAddress = text(hidden?.address);
    const requestedKey = text(hidden?.recordKey);
    const requestedRecord = requestedKey ? parts.recovery.records[requestedKey] ?? null : null;
    const address = requestedRecord?.address ?? requestedAddress;
    const expectedCreated = requestedRecord?.created_ms ?? epochOf(hidden?.created_ms);
    const term = address ? parts.terminalsByAddress.get(address) : null;
    const agent = address ? parts.agentsByAddress.get(address) : null;
    const exact = term && expectedCreated != null && terminalEpoch(term) === expectedCreated
      && (!requestedRecord || sameMachine(requestedRecord.machine, normalizeMachine(term.machine ?? agent?.machine, address)))
      && (!requestedRecord || recordMatchesTerminal(requestedRecord, address, term, agent));
    if (requestedRecord) addSaved(requestedRecord);
    if (!address) blockedErrors.push("The hidden entry has no stable terminal identity. Review it in the sidebar and try again.");
    else if (exact && terminalLive(term)) roots.add(address);
    else if (exact && terminalEnded(term)) addEndedTarget(address, expectedCreated);
    else if (!requestedRecord && requestedAddress && expectedCreated != null && term && terminalEpoch(term) === expectedCreated) {
      if (terminalLive(term)) roots.add(address);
      else if (terminalEnded(term)) addEndedTarget(address, expectedCreated);
    }
  }


  const affected = expandDescendants(roots, parts);
  const liveTargets = [];
  const affectedAgents = [];
  const agentStatuses = [];
  const recordKeys = new Set([...saved.keys()]);
  const seenRecords = new Set();
  for (const address of affected) {
    const term = parts.terminalsByAddress.get(address);
    if (!term || !terminalLive(term)) continue;
    const created_ms = terminalEpoch(term);
    if (created_ms == null) {
      blockedErrors.push(`The terminal identity for ${address} is incomplete. Review the hidden entry and try again.`);
      continue;
    }
    const agent = parts.agentsByAddress.get(address);
    const record = hiddenRecordFor(snapshot, parts, address, term, agent, group, now);
    if (!record) {
      blockedErrors.push(`The terminal identity for ${address} is unavailable. Review the hidden entry and try again.`);
      continue;
    }
    liveTargets.push({ address, created_ms });
    recordKeys.add(record.key);
    if (agent || terminalLike(term)) {
      if (!seenRecords.has(record.key)) {
        seenRecords.add(record.key);
        affectedAgents.push(record);
        const pane = parts.paneByAddress.get(address) ?? null;
        const owner = ownerForAffected(address, parts);
        agentStatuses.push({
          address,
          status: statusOf(agent, term),
          pane: pane?.pane ?? null,
          tab: owner.tab?.id ?? pane?.tab ?? null,
          machine: record.machine,
          key: record.key,
          owner: record.owner,
          visual: record.visual,
        });
      }
    }
  }
  const liveKeys = new Set(affectedAgents.map((record) => record.key));
  const hiddenSaved = [...saved.values()].filter((record) => !liveKeys.has(record.key));
  const targetMap = new Map();
  for (const target of [...liveTargets, ...endedTargets.values()]) targetMap.set(JSON.stringify([target.address, target.created_ms]), target);
  const targets = [...targetMap.values()];
  const uniqueErrors = [...new Set(blockedErrors.filter(Boolean))];
  const blocked = uniqueErrors.length > 0;
  const commands = blocked ? [] : liveTargets.map((target) => ({ name: "terminal.kill", args: { terminal: target.address } }));
  const affectedTerminals = [...new Set(liveTargets.map((target) => target.address))];
  const working = agentStatuses.filter((detail) => detail.status === "working" || detail.status === "blocked").length;
  const hiddenRemoval = {
    targets: targets.sort((a, b) => a.address.localeCompare(b.address) || a.created_ms - b.created_ms),
    recordKeys: [...recordKeys].sort(),
    group,
  };
  return {
    commands,
    spaces: 0,
    spaceNames: [],
    terminals: affectedTerminals.length,
    agents: affectedAgents.length,
    working,
    label: label ?? (hiddenSaved[0]?.title ?? null),
    affectedAgents,
    agentRecords: affectedAgents,
    agentStatuses,
    affectedTerminals,
    subRows: [],
    hiddenSaved,
    hiddenRemoval,
    blocked,
    error: uniqueErrors[0] ?? null,
    requiresConfirmation: true,
    pendingHiddenRemovals: pendingHiddenRemovalIdentity(snapshot.hiddenRemovals),
    target: { spaces: [], tabs: [], panes: [], terminals: affectedTerminals },
  };
}

export function buildClosePlan(p = {}, snapshot = {}) {
  const parts = snapshotParts(snapshot);
  if (isRecord(p?.hidden)) return hiddenClosePlan(p.hidden, snapshot, parts);
  const selection = selectedTarget(p, parts);
  const affected = expandDescendants(selection.roots, parts);
  for (const address of subAgentAddresses(selection.subs, parts)) affected.add(address);
  const affectedPaneIds = new Set(selection.paneIds);
  for (const address of affected) {
    const pane = parts.paneByAddress.get(address);
    if (pane) affectedPaneIds.add(pane.pane);
  }

  const S = new Set(selection.S);
  const T = new Set(selection.T);
  const P = new Set(affectedPaneIds);
  const explicitSpace = new Set(selection.S);
  const explicitTab = new Set(selection.T);
  const tabById = new Map();
  const spaceForTab = new Map();
  for (const space of parts.spaces) for (const tab of list(space.tabs)) {
    tabById.set(tab.id, tab);
    spaceForTab.set(tab.id, space);
  }

  // A pane selection promotes to tab closure only when every pane, including
  // mods, is affected. Explicit tab/space selections intentionally close mods.
  for (const [tabId, space] of spaceForTab) {
    if (T.has(tabId) || S.has(space.id) || explicitTab.has(tabId) || explicitSpace.has(space.id)) continue;
    const panesInTab = parts.panes.filter((pane) => pane.tab === tabId);
    const declaredPanes = Number(tabById.get(tabId)?.panes);
    const completePaneInventory = !Number.isFinite(declaredPanes) || declaredPanes <= 0 || declaredPanes === panesInTab.length;
    const selected = completePaneInventory && panesInTab.length > 0 && panesInTab.every((pane) => P.has(pane.pane));
    if (selected) {
      T.add(tabId);
      for (const pane of panesInTab) P.delete(pane.pane);
    }
  }

  // A pane-driven space promotion follows only fully closable tabs; an
  // unselected mod pane keeps its tab and its space alive.
  for (const space of parts.spaces) {
    if (S.has(space.id) || explicitSpace.has(space.id)) continue;
    const tabs = list(space.tabs);
    if (!tabs.length) continue;
    const closeable = tabs.every((tab) => T.has(tab.id));
    if (closeable && tabs.some((tab) => tabById.has(tab.id))) {
      S.add(space.id);
      for (const tab of tabs) T.delete(tab.id);
    }
  }

  const coveredTabs = new Set();
  for (const spaceId of S) for (const tab of list(parts.spaceById.get(spaceId)?.tabs)) coveredTabs.add(tab.id);
  for (const tabId of coveredTabs) T.delete(tabId);
  const coveredPanes = new Set();
  for (const spaceId of S) for (const pane of parts.panes.filter((item) => list(parts.spaceById.get(spaceId)?.tabs).some((tab) => tab.id === item.tab))) coveredPanes.add(pane.pane);
  for (const tabId of T) for (const pane of parts.panes.filter((item) => item.tab === tabId)) coveredPanes.add(pane.pane);
  for (const paneId of coveredPanes) P.delete(paneId);

  const commands = [
    ...[...S].map((id) => ({ name: "space.close", args: { id, confirmed: true } })),
    ...[...T].map((id) => ({ name: "tab.close", args: { id, confirmed: true } })),
    ...[...P].map((pane) => ({ name: "pane.close", args: { pane } })),
  ];
  const subRowAddresses = new Set(selection.subs.flatMap((item) => [item.terminal, item.agent, item.address].filter((address) => text(address))));
  const commandKeys = new Set(commands.map(commandKey));
  for (const address of affected) {
    if (parts.paneByAddress.has(address) || subRowAddresses.has(address)) continue;
    const command = { name: "terminal.kill", args: { terminal: address } };
    if (!commandKeys.has(commandKey(command))) {
      commands.push(command);
      commandKeys.add(commandKey(command));
    }
  }

  const now = Number.isFinite(Number(snapshot.now)) ? Number(snapshot.now) : Date.now();
  const { records: affectedAgents, details: agentStatuses } = agentRecordsFor(affected, parts, snapshot, now);
  for (const item of selection.subs) {
    if (!item.agent) continue;
    if (agentStatuses.some((detail) => detail.address === item.agent)) continue;
    const agent = parts.agentsByAddress.get(item.agent);
    const term = parts.terminalsByAddress.get(item.agent);
    if (!agent && !terminalLike(term)) continue;
    const owner = ownerForAffected(item.agent, parts).space;
    const record = makeRecord(snapshot, item.agent, parts.paneByAddress.get(item.agent) ?? null, owner, term, agent, now);
    if (record && !affectedAgents.some((candidate) => candidate.key === record.key)) {
      affectedAgents.push(record);
      agentStatuses.push({ address: item.agent, status: statusOf(agent, term), pane: parts.paneByAddress.get(item.agent)?.pane ?? null, tab: parts.paneByAddress.get(item.agent)?.tab ?? null, machine: record.machine, key: record.key, owner: record.owner, visual: record.visual });
    }
  }

  const agentCount = affectedAgents.length;
  const terminalCount = affected.size - agentCount;
  const named = (id) => parts.spaceById.get(id)?.name;
  const label = S.size === 1 && !T.size && !P.size ? named([...S][0])
    : !S.size && T.size === 1 && !P.size ? tabById.get([...T][0])?.name
    : !S.size && !T.size && P.size === 1 ? (agentCount ? "this agent" : "this CLI")
    : null;
  const working = agentStatuses.filter((detail) => detail.status === "working" || detail.status === "blocked").length;
  return {
    commands,
    spaces: S.size,
    spaceNames: [...S].map(named),
    terminals: terminalCount,
    agents: agentCount,
    working,
    label,
    affectedAgents,
    agentRecords: affectedAgents,
    agentStatuses,
    affectedTerminals: [...affected],
    subRows: selection.subs,
    pendingHiddenRemovals: pendingHiddenRemovalIdentity(snapshot.hiddenRemovals),
    requiresConfirmation: commands.length > 0 || selection.subs.length > 0,
    target: { spaces: [...S], tabs: [...T], panes: [...P], terminals: [...affected] },
  };
}

export function closePlanIdentity(plan) {
  const statuses = new Map(list(plan?.agentStatuses).map((item) => [item.address, item.status]));
  const hidden = plan?.hiddenRemoval ? {
    targets: list(plan.hiddenRemoval.targets).map((target) => [target.address, target.created_ms ?? null]),
    recordKeys: [...new Set(list(plan.hiddenRemoval.recordKeys).map(text).filter(Boolean))].sort(),
    group: normalizeHiddenGroup(plan.hiddenRemoval.group),
  } : null;
  const saved = list(plan?.hiddenSaved).map((record) => [
    record.key,
    record.machine,
    record.address,
    record.created_ms ?? null,
    record.title,
    record.owner?.id,
    record.visual?.key,
    record.visual?.folder,
  ]);
  const pending = list(plan?.pendingHiddenRemovals).map((event) => [
    event.id,
    list(event.targets).map((target) => [target.address, target.created_ms ?? null]),
    [...new Set(list(event.recordKeys).map(text).filter(Boolean))].sort(),
    normalizeHiddenGroup(event.group),
  ]);
  return JSON.stringify({
    commands: list(plan?.commands).map((command) => [command.name, command.args ?? {}]),
    agents: list(plan?.affectedAgents).map((record) => [record.key, record.machine, record.address, record.created_ms ?? null, statuses.get(record.address) ?? null, record.sessionPath, record.verified === true, record.owner?.id, record.visual?.key]),
    subs: list(plan?.subRows).map((item) => [item.kind, item.terminal, item.agent, item.pid, item.text]),
    hidden,
    saved,
    pending,
    blocked: plan?.blocked === true,
    error: text(plan?.error),
  });
}
