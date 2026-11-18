// desktop-notifications: decides which agent changes to announce. Pure: no
// `herdr` import, so tests can feed it plain objects.
//
// It mirrors Herdr's own attention rule (the one behind its sounds and toasts):
// needing you always alerts; finishing alerts only when you weren't looking.
// Sub-agents report through their parent and never alert.

const BLOCKED = new Set(["blocked"]);
const BUSY = new Set(["working", "blocked"]);
const WAITING = new Set(["blocked", "done"]);

/** What a status change means: "blocked", "done", or null. */
export function alertFor(prev, next, looking) {
  if (BLOCKED.has(next) && !BLOCKED.has(prev)) return "blocked";
  if (BUSY.has(prev) && next && !BUSY.has(next) && !looking) return "done";
  return null;
}

/** Whether the person can see this agent now: the window is in front and the
 *  agent is in the tab it shows. */
export function isLooking(agent, focus, windowActive) {
  return Boolean(windowActive && focus && agent.space === focus.space && agent.tab === focus.tab);
}

/** The notification's text, in Herdr's own words. */
export function message(agent, alert, detail = "") {
  const name = String(agent.program?.name || agent.app || "An agent").trim() || "An agent";
  const tab = String(agent.tab_name ?? "").trim().replace(/\s+/g, " ");
  const space = String(agent.space_name ?? "").trim().replace(/\s+/g, " ");
  const terminalTitle = String(agent.title ?? "").trim().replace(/\s+/g, " ");
  const task = terminalTitle && terminalTitle !== name ? terminalTitle : tab;
  const headline = task && task !== name ? `: ${task.slice(0, 96)}` : "";
  const title = `${name} ${alert === "blocked" ? "needs you" : "finished"}${headline}`;
  const subtitle = space && tab && space !== tab ? `${space} / ${tab}` : space || tab;
  const reported = alert === "blocked" ? String(detail ?? "").trim().replace(/\s+/g, " ").slice(0, 240) : "";
  return { title, subtitle, body: reported || task || tab || name };
}

/**
 * Compares the last statuses with the live agents.
 * `known`: Map address -> { status, posted } from the previous call (null on the first).
 * Returns { known, post: [{ address, alert, ...message }], clear: [address] }.
 * The first call only records: nothing that happened before Herdr loaded the mod
 * is announced.
 */
export function diff(known, agents, { focus, windowActive, subAgents = new Set(), want = {}, details = new Map() }) {
  const next = new Map();
  const post = [];
  const clear = [];
  for (const agent of agents) {
    if (subAgents.has(agent.address)) continue;
    const before = known?.get(agent.address);
    let posted = before?.posted ?? false;
    if (known && before && before.status !== agent.status) {
      const alert = alertFor(before.status, agent.status, isLooking(agent, focus, windowActive));
      if (alert && want[alert] !== false) {
        post.push({ address: agent.address, alert, ...message(agent, alert, details.get?.(agent.address) ?? details[agent.address] ?? "") });
        posted = true;
      } else if (posted && !WAITING.has(agent.status)) {
        clear.push(agent.address);
        posted = false;
      }
    }
    next.set(agent.address, { status: agent.status, posted });
  }
  for (const [address, entry] of known ?? []) {
    if (entry.posted && !next.has(address)) clear.push(address);
  }
  return { known: next, post, clear };
}
