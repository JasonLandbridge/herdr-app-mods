import { spaces, machines, panes, agents, terminals, shared } from "herdr";
import { buildClosePlan } from "./close-plan-core.js";
export * from "./close-plan-core.js";

export function currentCloseSnapshot() {
  return {
    spaces: spaces() ?? [],
    machines: machines() ?? [],
    panes: panes() ?? [],
    agents: agents() ?? [],
    terminals: terminals() ?? [],
    recovery: shared("over9k.recovery"),
    visibility: shared("herdr-custom.agentVisibility"),
    visualGroups: shared("over9k.visualGroups"),
    hiddenRemovals: shared("over9k.hiddenRemovals"),
    hiddenListings: shared("over9k.hiddenListings"),
    now: Date.now(),
  };
}

export function plan(p) {
  return buildClosePlan(p ?? {}, currentCloseSnapshot());
}
