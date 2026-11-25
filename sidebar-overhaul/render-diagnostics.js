export const RENDER_DIAGNOSTICS_KEY = "over9k.renderDiagnostics";
export const RENDER_DIAGNOSTICS_HISTORY_KEY = "over9k.renderDiagnostics.history";
export const RENDER_DIAGNOSTICS_VERSION = 2;
export const RENDER_DIAGNOSTIC_STAGES = Object.freeze([
  "native-snapshot",
  "grouping",
  "recovery-capture-persist",
  "visual-publication",
  "hidden-removal",
  "visibility-reduce",
  "list-build",
  "final-tree-order",
]);

const MAX_FAILURES = 8;
const MAX_STAGES = RENDER_DIAGNOSTIC_STAGES.length;
const MAX_COUNT_FIELDS = 24;
const MAX_NAME = 80;
const MAX_MESSAGE = 512;
const MAX_STACK = 2048;
const URL_PATTERN = /\b(?:https?|file|ssh|ftp|ws|wss):\/\/[^\s)]+/gi;
const PATH_PATTERN = /(^|[\s("'`])((?:\/|~\/|[A-Za-z]:[\\/])[^\s"'`),;]*)/g;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function storageFromGlobal() {
  try { return globalThis.localStorage; } catch { return null; }
}

function safeMode(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(mode) ? mode : "unknown";
}

function safeStage(value) {
  return RENDER_DIAGNOSTIC_STAGES.includes(value) ? value : null;
}

function safeCounts(value) {
  if (!isObject(value)) return {};
  const counts = {};
  let count = 0;
  for (const [key, number] of Object.entries(value)) {
    if (count >= MAX_COUNT_FIELDS) break;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) || !finite(number) || number < 0) continue;
    counts[key] = Math.floor(number);
    count++;
  }
  return counts;
}

function bounded(value, limit) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

function scrub(value, preserveBasename = false) {
  let text = value.replace(URL_PATTERN, "<url>");
  text = text.replace(PATH_PATTERN, (match, prefix, path) => {
    const suffix = path.match(/(:\d+(?::\d+)?)$/)?.[1] ?? "";
    if (!preserveBasename) return `${prefix}<path>`;
    const withoutSuffix = suffix ? path.slice(0, -suffix.length) : path;
    const basename = withoutSuffix.split(/[\\/]/).pop() || "<path>";
    return `${prefix}${basename}${suffix}`;
  });
  return text;
}

function errorField(error, field) {
  try { return error?.[field]; } catch { return null; }
}

function errorText(error) {
  if (typeof error === "string") return error;
  const message = errorField(error, "message");
  if (typeof message === "string") return message;
  try { return String(error); } catch { return "Thrown value"; }
}

function normalizeError(error) {
  try {
    const rawName = errorField(error, "name");
    let fallbackName = "Error";
    try { fallbackName = error?.constructor?.name || fallbackName; } catch { /* bounded fallback below */ }
    const name = bounded(scrub(typeof rawName === "string" ? rawName : fallbackName), MAX_NAME) || "Error";
    const message = bounded(scrub(errorText(error)), MAX_MESSAGE);
    const rawStack = errorField(error, "stack");
    const stack = bounded(scrub(typeof rawStack === "string" ? rawStack : "", true), MAX_STACK);
    return { name, message, ...(stack ? { stack } : {}) };
  } catch {
    return { name: "Error", message: "Thrown value" };
  }
}

function elapsed(startedAt, endedAt) {
  return finite(startedAt) && finite(endedAt) ? Math.max(0, Math.floor(endedAt - startedAt)) : null;
}

function normalizeStage(value) {
  if (!isObject(value) || !safeStage(value.name) || !finite(value.startedAt)) return null;
  return {
    name: value.name,
    startedAt: value.startedAt,
    ...(finite(value.elapsedMs) ? { elapsedMs: Math.max(0, Math.floor(value.elapsedMs)) } : {}),
    counts: safeCounts(value.counts),
  };
}

function normalizeAttempt(value) {
  if (!isObject(value)) return null;
  const status = ["running", "success", "failure", "incomplete"].includes(value.status) ? value.status : null;
  if (!status || !finite(value.startedAt)) return null;
  const stages = Array.isArray(value.stages) ? value.stages.slice(-MAX_STAGES).map(normalizeStage).filter(Boolean) : [];
  const attempt = {
    status,
    mode: safeMode(value.mode),
    startedAt: value.startedAt,
    ...(finite(value.endedAt) ? { endedAt: value.endedAt } : {}),
    ...(finite(value.elapsedMs) ? { elapsedMs: Math.max(0, Math.floor(value.elapsedMs)) } : {}),
    ...(safeStage(value.lastStage) ? { lastStage: value.lastStage } : {}),
    stages,
    counts: safeCounts(value.counts),
  };
  if (finite(value.detectedAt)) attempt.detectedAt = value.detectedAt;
  if (status === "failure" && isObject(value.error)) {
    attempt.error = {
      name: scrub(bounded(value.error.name, MAX_NAME)) || "Error",
      message: scrub(bounded(value.error.message, MAX_MESSAGE)),
      ...(bounded(value.error.stack, MAX_STACK) ? { stack: scrub(bounded(value.error.stack, MAX_STACK), true) } : {}),
    };
  }
  return attempt;
}

function normalizeFailures(value) {
  if (!isObject(value) || !Array.isArray(value.failures)) return [];
  return value.failures
    .slice(0, MAX_FAILURES)
    .map(normalizeAttempt)
    .filter((attempt) => attempt && ["failure", "incomplete"].includes(attempt.status));
}

function parseStored(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function createRenderDiagnostics({ storage = storageFromGlobal(), now = () => Date.now() } = {}) {
  let disabled = false;
  let lastNow = 0;
  try { disabled = !storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function"; }
  catch { disabled = true; }

  const timestamp = () => {
    try {
      const value = Number(now());
      if (Number.isFinite(value)) {
        lastNow = value;
        return value;
      }
    } catch { /* logging must never affect rendering */ }
    return lastNow;
  };

  let current = null;
  let history = [];

  const writeCurrent = (attempt) => {
    if (disabled) return;
    try {
      storage.setItem(RENDER_DIAGNOSTICS_KEY, JSON.stringify({
        version: RENDER_DIAGNOSTICS_VERSION,
        current: attempt,
      }));
    } catch { disabled = true; }
  };

  const writeHistory = () => {
    if (disabled) return;
    try {
      storage.setItem(RENDER_DIAGNOSTICS_HISTORY_KEY, JSON.stringify({
        version: RENDER_DIAGNOSTICS_VERSION,
        failures: history,
      }));
    } catch { disabled = true; }
  };

  if (!disabled) {
    let currentRaw;
    let historyRaw;
    try {
      currentRaw = storage.getItem(RENDER_DIAGNOSTICS_KEY);
      historyRaw = storage.getItem(RENDER_DIAGNOSTICS_HISTORY_KEY);
    } catch {
      disabled = true;
    }

    if (!disabled) {
      const storedCurrent = parseStored(currentRaw);
      const storedHistory = parseStored(historyRaw);
      history = normalizeFailures(storedHistory);

      if (storedCurrent?.version === 1) {
        current = normalizeAttempt(storedCurrent.current);
        history = [...normalizeFailures(storedCurrent), ...history].slice(0, MAX_FAILURES);
        writeHistory();
        writeCurrent(current);
      } else if (storedCurrent?.version === RENDER_DIAGNOSTICS_VERSION) {
        current = normalizeAttempt(storedCurrent.current);
      }
    }
  }

  const noOp = { setMode() {}, stage() {}, complete() {}, fail() {} };

  const begin = (mode = "unknown") => {
    if (disabled) return noOp;

    const startedAt = timestamp();
    if (current?.status === "running") {
      const interrupted = normalizeAttempt({ ...current, status: "incomplete", detectedAt: startedAt });
      if (interrupted) {
        history = [interrupted, ...history].slice(0, MAX_FAILURES);
        writeHistory();
      }
    } else if (current?.status === "failure" || current?.status === "incomplete") {
      const archived = normalizeAttempt(current);
      if (archived) {
        history = [archived, ...history].slice(0, MAX_FAILURES);
        writeHistory();
      }
    }

    const attempt = {
      status: "running",
      mode: safeMode(mode),
      startedAt,
      stages: [],
      counts: {},
    };
    current = attempt;
    writeCurrent(attempt);

    let finished = false;
    const closeStage = (at) => {
      const last = attempt.stages.at(-1);
      if (last && last.elapsedMs === undefined) last.elapsedMs = elapsed(last.startedAt, at);
    };
    const persist = () => writeCurrent(attempt);
    const guard = (work) => {
      try { work(); } catch { disabled = true; }
    };
    return {
      setMode(value) {
        if (finished) return;
        guard(() => {
          attempt.mode = safeMode(value);
          persist();
        });
      },
      stage(name, counts = {}) {
        if (finished || !safeStage(name)) return;
        guard(() => {
          const at = timestamp();
          closeStage(at);
          attempt.stages.push({ name, startedAt: at, counts: safeCounts(counts) });
          if (attempt.stages.length > MAX_STAGES) attempt.stages.shift();
          attempt.lastStage = name;
          attempt.counts = safeCounts(counts);
          persist();
        });
      },
      complete(counts = null) {
        if (finished) return;
        finished = true;
        guard(() => {
          const endedAt = timestamp();
          closeStage(endedAt);
          if (counts) attempt.counts = safeCounts(counts);
          attempt.status = "success";
          attempt.endedAt = endedAt;
          attempt.elapsedMs = elapsed(attempt.startedAt, endedAt);
          persist();
        });
      },
      fail(error, counts = null) {
        if (finished) return;
        finished = true;
        guard(() => {
          const endedAt = timestamp();
          closeStage(endedAt);
          if (counts) attempt.counts = safeCounts(counts);
          attempt.status = "failure";
          attempt.endedAt = endedAt;
          attempt.elapsedMs = elapsed(attempt.startedAt, endedAt);
          attempt.error = normalizeError(error);
          persist();
        });
      },
    };
  };

  return { begin };
}
