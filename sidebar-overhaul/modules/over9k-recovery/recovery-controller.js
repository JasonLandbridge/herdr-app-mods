import {
  OMP_HEADER_LINES,
  directoryOf,
  displayTitle,
  isAbsolutePath,
  isOmpRecord,
  liveOmpMetadata,
  machineForAddress,
  normalizePath,
  parseSessionHeader,
  validateSessionHeader,
} from "./session-metadata.js";

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

export const RECOVERY_STATE = "over9k.recovery";

export function recoveryRecords(value) {
  const records = value && typeof value.records === "object" && !Array.isArray(value.records) ? value.records : {};
  return Object.entries(records).map(([key, item]) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    return {
      ...item,
      key: text(item.key) ?? key,
      machine: text(item.machine) ?? text(item.visual?.machine) ?? machineForAddress(item.address),
      address: text(item.address),
      cwd: normalizePath(item.cwd),
      title: text(item.title) ?? text(item.address) ?? "Untitled session",
      app: text(item.app),
      sessionId: text(item.sessionId),
      sessionPath: normalizePath(item.sessionPath),
      verified: item.verified === true && Boolean(normalizePath(item.sessionPath)),
      owner: item.owner && typeof item.owner === "object" ? item.owner : {},
      visual: item.visual && typeof item.visual === "object" ? item.visual : {},
      lastSeen: Number.isFinite(Number(item.lastSeen)) ? Number(item.lastSeen) : null,
    };
  }).filter(Boolean);
}

export function selectedRecord(records, key) {
  return records.find((record) => record.key === key) ?? null;
}

export function scopedRecoveryRecord({ machine = null, folder = null, label = null } = {}) {
  const scopedMachine = text(machine);
  const scopedFolder = normalizePath(folder);
  const scopedLabel = text(label);
  return {
    key: null,
    title: scopedLabel ? `Group recovery · ${scopedLabel}` : "Group recovery (no saved agent identity)",
    app: "omp",
    machine: scopedMachine,
    cwd: scopedFolder,
    owner: {},
    visual: { key: null, label: scopedLabel, folder: scopedFolder, machine: scopedMachine, kind: "group" },
    sessionId: null,
    sessionPath: null,
    verified: false,
    ephemeral: true,
  };
}

export function selectedRecoveryRecord(records, key, propsValue = {}) {
  const saved = selectedRecord(records, key);
  if (saved || text(key)) return saved;
  if (!text(propsValue.machine) && !normalizePath(propsValue.folder) && !text(propsValue.label)) return null;
  return scopedRecoveryRecord(propsValue);
}

function optionsFor(machine) {
  return machine ? { on: machine } : {};
}

function ok(result) {
  return result && Number(result.code) === 0;
}

function errorText(result, fallback) {
  const detail = text(result?.stderr) ?? text(result?.stdout);
  return detail ? `${fallback}: ${detail}` : fallback;
}

function sameMachine(a, b) {
  return (text(a) ?? null) === (text(b) ?? null);
}

function hostList(host, name) {
  const value = host?.[name];
  return typeof value === "function" ? value() ?? [] : Array.isArray(value) ? value : [];
}

function snapshot(host) {
  return {
    spaces: hostList(host, "spaces"),
    panes: hostList(host, "panes"),
    terminals: hostList(host, "terminals"),
    agents: hostList(host, "agents"),
  };
}

function paneFor(panes, address) {
  return panes.find((item) => item?.terminal === address || item?.address === address) ?? null;
}

function spaceFor(spaces, pane, agent) {
  if (pane?.space) return spaces.find((space) => space.id === pane.space) ?? null;
  const agentSpace = text(agent?.space);
  if (agentSpace) return spaces.find((space) => space.id === agentSpace) ?? null;
  const tabId = text(pane?.tab) ?? text(agent?.tab);
  if (tabId) {
    return spaces.find((space) => Array.isArray(space.tabs) && space.tabs.some((tab) => tab.id === tabId)) ?? null;
  }
  return null;
}

function tabFor(space, pane, agent) {
  if (!space) return null;
  const tabId = text(pane?.tab) ?? text(agent?.tab);
  return (Array.isArray(space.tabs) ? space.tabs : []).find((tab) => tab.id === tabId) ?? null;
}

export function liveOmpSessions(frame = {}) {
  const terminals = Array.isArray(frame.terminals) ? frame.terminals : [];
  const agents = Array.isArray(frame.agents) ? frame.agents : [];
  const byAddress = new Map();
  for (const agent of agents) if (agent?.address) byAddress.set(agent.address, agent);
  for (const terminal of terminals) if (terminal?.address && !byAddress.has(terminal.address)) byAddress.set(terminal.address, terminal);
  return [...byAddress.entries()].map(([address, agent]) => {
    const terminal = terminals.find((item) => item?.address === address) ?? null;
    const metadata = liveOmpMetadata(terminal, agent, address);
    if (!metadata) return null;
    const pane = paneFor(frame.panes ?? [], address);
    const space = spaceFor(frame.spaces ?? [], pane, agent);
    const tab = tabFor(space, pane, agent);
    return {
      ...metadata,
      machine: text(space?.machine) ?? metadata.machine ?? machineForAddress(address),
      cwd: normalizePath(pane?.cwd ?? space?.folder ?? metadata.cwd),
      pane: pane?.pane ?? pane?.id ?? null,
      tab: tab?.id ?? text(pane?.tab) ?? text(agent?.tab) ?? null,
      space: space?.id ?? text(agent?.space) ?? null,
      spaceActive: space?.active === true,
    };
  }).filter(Boolean);
}


export function findLiveVerified(record, live) {
  if (!record?.verified || !normalizePath(record.sessionPath)) return null;
  const path = normalizePath(record.sessionPath);
  return (Array.isArray(live) ? live : []).find((item) => {
    if (!sameMachine(item.machine, record.machine)) return false;
    if (normalizePath(item.sessionPath) !== path) return false;
    return !record.sessionId || !item.sessionId || record.sessionId === item.sessionId;
  }) ?? null;
}

export function focusCommands(live) {
  if (!live) return [];
  const commands = [];
  if (live.space && !live.spaceActive) commands.push({ name: "space.select", args: { id: live.space } });
  if (live.tab) commands.push({ name: "tab.select", args: { id: live.tab } });
  if (live.pane) commands.push({ name: "pane.focus", args: { pane: live.pane } });
  else if (live.address) commands.push({ name: "agent.focus", args: { terminal: live.address } });
  return commands;
}

const VISIBILITY_ACTIONS = "herdr-custom.agentVisibility.actions";

function queueVisibilityAction(host, action) {
  if (typeof host?.setShared !== "function") return;
  const queued = typeof host.shared === "function" ? host.shared(VISIBILITY_ACTIONS) : [];
  host.setShared(VISIBILITY_ACTIONS, [...(Array.isArray(queued) ? queued : []), action]);
}

function queueReveal(host, addresses, entries = {}) {
  const clean = [...new Set((Array.isArray(addresses) ? addresses : [addresses]).map(text).filter(Boolean))];
  if (!clean.length) return;
  queueVisibilityAction(host, { type: "reveal", addresses: clean, entries });
}

function revealAddresses(frame, target) {
  const clean = text(target);
  if (!clean) return [];
  const byAddress = new Map();
  for (const item of [...(frame?.terminals ?? []), ...(frame?.agents ?? [])]) {
    if (!item?.address) continue;
    byAddress.set(item.address, { ...byAddress.get(item.address), ...item });
  }
  const addresses = [];
  const seen = new Set();
  let address = clean;
  while (address && !seen.has(address)) {
    seen.add(address);
    addresses.push(address);
    address = text(byAddress.get(address)?.parent);
  }
  return addresses;
}

function revealRecord(host, record, live = null) {
  const target = text(live?.address) ?? text(record?.address);
  const addresses = revealAddresses(snapshot(host), target);
  if (!addresses.length) return;
  const entries = {};
  for (const address of addresses) {
    const item = [...hostList(host, "terminals"), ...hostList(host, "agents")].find((candidate) => candidate?.address === address);
    const created_ms = Number.isFinite(Number(item?.created_ms)) ? Number(item.created_ms) : null;
    const metadata = {};
    if (created_ms !== null) metadata.created_ms = created_ms;
    if (address === target && text(record?.key)) metadata.recordKey = text(record.key);
    if (address === target && created_ms === null && Number.isFinite(Number(record?.created_ms))) metadata.created_ms = Number(record.created_ms);
    entries[address] = metadata;
  }
  queueReveal(host, addresses, entries);
}

function queueRevealLaunch(host, { machine = null, folder, recordKey = null } = {}) {
  const exactFolder = normalizePath(folder);
  if (!exactFolder) return;
  const before = hostList(host, "terminals").map((item) => text(item?.address)).filter(Boolean);
  queueVisibilityAction(host, {
    type: "reveal-launch",
    machine: text(machine),
    folder: exactFolder,
    ...(text(recordKey) ? { recordKey: text(recordKey) } : {}),
    before,
  });
}

function runCommand(host, command) {
  if (typeof host.run !== "function") return "This host cannot open native spaces or tabs.";
  try {
    host.run(command.name, command.args);
    return null;
  } catch (error) {
    return String(error);
  }
}

export function sessionRoot(record = {}, propsValue = {}) {
  const explicit = normalizePath(record.sessionRoot ?? propsValue.sessionRoot);
  if (explicit) return explicit;
  const fromSavedPath = directoryOf(record.sessionPath);
  if (fromSavedPath) return fromSavedPath;
  const machine = text(record.machine) ?? text(record.visual?.machine) ?? text(propsValue.machine) ?? null;
  if (!machine && propsValue.home) return normalizePath(`${propsValue.home}/.omp/agent/sessions`);
  return normalizePath(record.cwd ?? propsValue.folder);
}

export class RecoveryController {
  constructor(host) {
    this.host = host ?? {};
  }
  async restoreGroup(records) {
    const seen = new Set();
    const results = [];
    for (const record of records) {
      const identity = JSON.stringify([record.machine ?? null, record.sessionPath]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (!record.verified) {
        results.push({ key: record.key, ok: false, error: "Session requires explicit verification." });
        continue;
      }
      try { results.push({ key: record.key, ...await this.restore(record) }); }
      catch (error) { results.push({ key: record.key, ok: false, error: String(error) }); }
    }
    return { ok: results.every(result => result.ok), results };
  }

  frame() {
    return snapshot(this.host);
  }

  async readHeader(path, expected = {}) {
    const exactPath = normalizePath(path);
    if (!exactPath || !isAbsolutePath(exactPath) || !/\.jsonl$/i.test(exactPath)) {
      return { ok: false, error: "Choose an absolute .jsonl session file." };
    }
    if (typeof this.host.exec !== "function") return { ok: false, error: "This host cannot inspect OMP sessions." };
    let result;
    try {
      result = await this.host.exec("head", ["-n", String(OMP_HEADER_LINES), exactPath], optionsFor(expected.machine));
    } catch (error) {
      return { ok: false, error: `Couldn't read the OMP session header: ${String(error)}` };
    }
    if (!ok(result)) return { ok: false, error: errorText(result, "Couldn't read the OMP session header") };
    const header = parseSessionHeader(result.stdout ?? "", OMP_HEADER_LINES);
    return validateSessionHeader(header, { path: exactPath, sessionId: expected.sessionId, cwd: expected.cwd });
  }

  async remoteSessionRoot(machine) {
    if (!machine || typeof this.host.exec !== "function") return null;
    let result;
    try {
      // Resolve the remote home without interpolating a path into a shell.
      result = await this.host.exec("printenv", ["HOME"], optionsFor(machine));
    } catch {
      return null;
    }
    if (!ok(result)) return null;
    const remoteHome = normalizePath(result.stdout);
    return remoteHome ? `${remoteHome}/.omp/agent/sessions` : null;
  }

  async discover({ root, machine = null, cwd = null, sessionId = null } = {}) {
    const exactRoot = normalizePath(root);
    if (!exactRoot || !isAbsolutePath(exactRoot)) return { ok: false, error: "The OMP session folder is unavailable." };
    if (typeof this.host.exec !== "function") return { ok: false, error: "This host cannot enumerate OMP sessions." };
    let result;
    try {
      // Direct executable arguments: no shell interpolation of root or paths.
      result = await this.host.exec("find", ["-P", exactRoot, "-type", "f", "-name", "*.jsonl", "-print"], optionsFor(machine));
    } catch (error) {
      return { ok: false, error: `Couldn't enumerate OMP sessions: ${String(error)}` };
    }
    if (!ok(result)) return { ok: false, error: errorText(result, "Couldn't enumerate OMP sessions") };
    const paths = [...new Set(String(result.stdout ?? "").split(/\r?\n/).map(normalizePath).filter((path) => path && /\.jsonl$/i.test(path)))];
    const candidates = [];
    const rejected = [];
    for (const path of paths) {
      const header = await this.readHeader(path, { machine, cwd, sessionId });
      if (header.ok) candidates.push({ path, header, title: displayTitle({}, header) });
      else rejected.push({ path, error: header.error });
    }
    return { ok: true, candidates, rejected };
  }

  async restore(record, { path = null, confirm = false, machine = null, folder = null } = {}) {
    if (!isOmpRecord(record)) return { ok: false, error: "This saved record is unsupported; Claude and Codex sessions are never sent to OMP." };
    const targetMachine = text(machine) ?? text(record.machine) ?? text(record.visual?.machine) ?? null;
    const expectedCwd = normalizePath(folder ?? record.cwd ?? record.visual?.folder);
    if (!expectedCwd) return { ok: false, error: "The saved record has no original working folder." };
    const exactPath = normalizePath(path ?? record.sessionPath);
    if (!exactPath) return { ok: false, error: "Select an exact OMP session file before restoring." };
    if (!record.verified && !confirm) return { ok: false, error: "Select and confirm one validated OMP session before restoring." };
    const header = await this.readHeader(exactPath, { machine: targetMachine, sessionId: record.sessionId, cwd: expectedCwd });
    if (!header.ok) return header;
    const verified = { ...record, machine: targetMachine, cwd: header.cwd, sessionId: header.sessionId, sessionPath: exactPath, verified: true };
    const live = findLiveVerified(verified, liveOmpSessions(this.frame()));
    if (live) revealRecord(this.host, verified, live);
    const focused = focusCommands(live);
    if (live) {
      for (const command of focused) {
        const dispatchError = runCommand(this.host, command);
        if (dispatchError) return { ok: false, error: `Couldn't focus the existing OMP session: ${dispatchError}` };
      }
      return { ok: true, focused: true, launched: false, path: exactPath, header, commands: focused };
    }
    const spaces = hostList(this.host, "spaces");
    const space = spaces.find((item) => sameMachine(item?.machine, targetMachine) && normalizePath(item?.folder) === expectedCwd) ?? null;
    const argv = ["omp", "--restore", exactPath];
    const commands = [];
    queueRevealLaunch(this.host, { machine: targetMachine, folder: expectedCwd, recordKey: verified.key });
    if (space) {
      if (!space.active) {
        const command = { name: "space.select", args: { id: space.id } };
        const dispatchError = runCommand(this.host, command);
        if (dispatchError) return { ok: false, error: `Couldn't focus the OMP space: ${dispatchError}` };
        commands.push(command);
      }
      const command = { name: "tab.new", args: { space: space.id, folder: expectedCwd, argv } };
      const dispatchError = runCommand(this.host, command);
      if (dispatchError) return { ok: false, error: `Couldn't open the OMP tab: ${dispatchError}` };
      commands.push(command);
    } else {
      const command = { name: "space.new", args: { machine: targetMachine ?? "", folder: expectedCwd, argv } };
      const dispatchError = runCommand(this.host, command);
      if (dispatchError) return { ok: false, error: `Couldn't open the OMP space: ${dispatchError}` };
      commands.push(command);
    }
    return { ok: true, focused: false, launched: true, path: exactPath, header, commands };
  }
}
