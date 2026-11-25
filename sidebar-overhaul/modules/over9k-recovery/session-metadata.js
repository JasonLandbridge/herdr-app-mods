// Metadata-only OMP session inspection. Never parse past the JSONL header.

export const OMP_HEADER_LINES = 2;

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
const OMP_PROGRAM = /^(?:omp)(?:[-_.].*)?$/i;
const UNSUPPORTED_PROGRAM = /^(?:claude|codex)(?:[-_.].*)?$/i;

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

export function normalizePath(value) {
  const result = text(value);
  if (!result) return null;
  const slash = result.replace(/\\/g, "/");
  return slash.length > 1 ? slash.replace(/\/+$/, "") : slash;
}

export function isAbsolutePath(value) {
  return Boolean(normalizePath(value) && ABSOLUTE.test(normalizePath(value)));
}

export function machineForAddress(address) {
  const value = text(address);
  const slash = value?.indexOf("/") ?? -1;
  return slash > 0 ? value.slice(0, slash) : null;
}

export function directoryOf(value) {
  const path = normalizePath(value);
  if (!path) return null;
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "/";
}

function basename(value) {
  return text(value)?.split(/[\\/]/).pop() ?? null;
}

function foregroundArgv(terminal, agent) {
  // The terminal's current foreground is authoritative. Never concatenate a
  // stale wrapper argv with a current foreground argv.
  if (Array.isArray(terminal?.foreground?.argv)) return terminal.foreground.argv;
  if (Array.isArray(agent?.foreground?.argv)) return agent.foreground.argv;
  return [];
}

export function restorePathFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const program = basename(argv[0]);
  if (!OMP_PROGRAM.test(program ?? "")) return null;
  for (let i = 0; i < argv.length; i++) {
    const value = text(argv[i]);
    if (!value) continue;
    const inline = /^(?:--restore)=(.+)$/i.exec(value)?.[1];
    const next = /^--restore$/i.test(value) ? text(argv[i + 1]) : null;
    const path = normalizePath(inline ?? next);
    if (path && isAbsolutePath(path) && /\.jsonl$/i.test(path)) return path;
  }
  return null;
}

function labelsOf(terminal, agent) {
  const labels = terminal?.labels && typeof terminal.labels === "object" ? terminal.labels : {};
  const agentLabels = agent?.labels && typeof agent.labels === "object" ? agent.labels : {};
  return { ...labels, ...agentLabels };
}

export function liveOmpMetadata(terminal = null, agent = null, address = null) {
  const argv = foregroundArgv(terminal, agent);
  const program = basename(argv[0]) ?? basename(terminal?.program?.key) ?? basename(agent?.program?.key) ?? basename(agent?.app) ?? basename(terminal?.agent);
  if (!OMP_PROGRAM.test(program ?? "")) return null;
  const labels = labelsOf(terminal, agent);
  const restorePath = restorePathFromArgv(argv);
  const labelPath = normalizePath(labels["revive.transcript"] ?? labels.transcript);
  const path = restorePath ?? labelPath;
  if (!path) return null;
  const useLabels = !restorePath || Boolean(labelPath && labelPath === path);
  return {
    address: text(address ?? agent?.address ?? terminal?.address),
    machine: machineForAddress(address ?? agent?.address ?? terminal?.address),
    sessionPath: path,
    sessionId: useLabels ? text(labels["revive.session"] ?? labels.sessionId) : null,
    cwd: normalizePath(useLabels ? labels["revive.cwd"] : null) ?? normalizePath(terminal?.cwd ?? agent?.cwd),
    argv,
  };
}

export function recordAgent(record = {}) {
  const app = basename(record.app) ?? basename(record.program?.key) ?? basename(record.agent);
  if (UNSUPPORTED_PROGRAM.test(app ?? "")) return app.toLowerCase().startsWith("claude") ? "claude" : "codex";
  if (OMP_PROGRAM.test(app ?? "")) return "omp";
  const path = normalizePath(record.sessionPath);
  // Old OMP captures sometimes omitted app but retained their .omp path.
  if (!app && /\/(?:\.omp)(?:\/|$)/i.test(path ?? "")) return "omp";
  return app ? app.toLowerCase() : "unknown";
}

export function isOmpRecord(record = {}) {
  return recordAgent(record) === "omp";
}

export function isUnsupportedRecord(record = {}) {
  const kind = recordAgent(record);
  return kind !== "omp";
}

function invalid(error) {
  return { ok: false, error };
}

/**
 * Parse only the first OMP header lines. The caller must supply a bounded
 * `head` result; this function intentionally ignores every line after the
 * bounded prefix and stops at the first conversation row.
 */
export function parseSessionHeader(textValue, maxLines = OMP_HEADER_LINES) {
  const lines = String(textValue ?? "").split(/\r?\n/).slice(0, maxLines);
  let title = null;
  let session = null;
  let first = true;
  for (const line of lines) {
    const source = line.trim();
    if (!source) continue;
    let row;
    try { row = JSON.parse(source); }
    catch { return invalid("The OMP header contains invalid JSON."); }
    if (!row || typeof row !== "object" || Array.isArray(row)) return invalid("The OMP header row is not an object.");
    if (first && row.type !== "title") return invalid("The file is not an OMP session (missing the title header).");
    first = false;
    if (row.type === "message" || row.type === "tool_call" || row.type === "tool_result") break;
    if (row.type === "title") {
      if (text(row.title)) title = text(row.title);
      continue;
    }
    if (row.type === "session") {
      session = row;
      continue;
    }
  }
  if (!session || session.type !== "session") return invalid("The file is not an OMP session (missing a session header).");
  const sessionId = text(session.id ?? session.sessionId);
  if (!sessionId) return invalid("The OMP session header has no session identity.");
  const cwd = normalizePath(session.cwd);
  if (!cwd || !isAbsolutePath(cwd)) return invalid("The OMP session header has no absolute working folder.");
  return { ok: true, sessionId, cwd, title, type: session.type, version: session.version ?? null };
}

export function validateSessionHeader(header, { path = null, sessionId = null, cwd = null } = {}) {
  if (!header?.ok) return header ?? invalid("The OMP header could not be read.");
  const expectedPath = path ? normalizePath(path) : null;
  if (expectedPath && (!isAbsolutePath(expectedPath) || !/\.jsonl$/i.test(expectedPath))) return invalid("The OMP session path must be an absolute .jsonl file.");
  if (text(sessionId) && header.sessionId !== text(sessionId)) return invalid("The OMP session identity does not match the saved record.");
  const expectedCwd = normalizePath(cwd);
  if (expectedCwd && header.cwd !== expectedCwd) return invalid("The OMP session working folder does not match the saved record.");
  return { ...header, path: expectedPath ?? null };
}

export function recordScope(record = {}, propsValue = {}) {
  const machine = text(record.machine) ?? text(record.visual?.machine) ?? text(propsValue.machine) ?? null;
  const cwd = normalizePath(record.cwd ?? record.visual?.folder ?? propsValue.folder);
  return { machine, cwd };
}

export function displayTitle(record = {}, header = null) {
  return text(record.title) ?? text(header?.title) ?? "Untitled OMP session";
}
