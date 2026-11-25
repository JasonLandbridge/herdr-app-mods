const STATUSES = new Set(["blocked", "done", "working", "idle", "needs-input"]);
const SHELLS = /^(?:shell|zsh|bash|fish|sh|dash|ksh|tcsh|nushell|nu)$/i;
const PROGRAMS = /^(?:claude|codex|pi|opencode|gemini|aider|amp|cursor|omp)(?:$|[-_.])/i;

export function reportedTerminalStatus(value) {
  if (typeof value === "string") return STATUSES.has(value) ? value : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value.status ?? value.state;
  return typeof status === "string" && STATUSES.has(status) ? status : null;
}

export function terminalStatus(term) {
  return reportedTerminalStatus(term?.status) ?? reportedTerminalStatus(term?.report);
}

export function isAgentTerminal(term, agentAddresses = new Set()) {
  if (!term?.address) return false;
  if (agentAddresses.has(term.address) || term.program?.agent || PROGRAMS.test(term.agent ?? "")) return true;
  if (SHELLS.test(term.agent ?? "") || (!term.agent && SHELLS.test(term.program?.key ?? ""))) return false;
  return Boolean(terminalStatus(term));
}
