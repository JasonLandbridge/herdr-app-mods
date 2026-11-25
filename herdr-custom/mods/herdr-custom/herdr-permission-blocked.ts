/**
 * OMP permission bridge, owned by the herdr-custom mod.
 * The OMP extension entry point re-exports this file so the implementation
 * lives with the rest of the custom Herdr work.
 *
 * permissions:ui_prompt -> herdr:blocked active
 * permissions:decision  -> herdr:blocked inactive
 */

type PermissionEventHandler = (data: unknown) => void;

interface PermissionEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: PermissionEventHandler): unknown;
}

interface ExtensionRuntime {
  events: PermissionEventBus;
}

function field(data: unknown, key: string): unknown {
  return data !== null && typeof data === "object"
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

function stringField(data: unknown, key: string): string | null {
  const value = field(data, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function labelFor(uiPrompt: unknown): string {
  const forwarding = field(uiPrompt, "forwarding");
  const surface = stringField(uiPrompt, "surface");
  const label =
    forwarding !== null && typeof forwarding === "object"
      ? "Permission Required (Subagent)"
      : "Permission Required";
  return surface === null ? label : `${label}: ${surface}`;
}


function setStatus(state: "blocked" | "working" | "idle"): void {
  if (!process.env.HC_TERMINAL_ID || !process.stdout.isTTY) {
    return;
  }
  try {
    process.stdout.write(`\x1b]7501;state=${state}:app=omp\x1b\\`);
  } catch {
    // A status write must never affect permission enforcement.
  }
}

export default function herdrPermissionBlockedExtension(
  pi: ExtensionRuntime,
): void {
  /** requestId -> label for every prompt currently waiting on a human. */
  const pending = new Map<string, string>();
  let unpairable = 0;

  function report(active: boolean, label?: string): void {
    try {
      pi.events.emit(
        "herdr:blocked",
        label === undefined ? { active } : { active, label },
      );
    } catch {
      // A failing Herdr listener must never affect permission enforcement.
    }
  }

  pi.events.on("permissions:ui_prompt", (data: unknown) => {
    const id = stringField(data, "requestId");
    // A forwarded lifecycle can re-report an id whose first prompt is still
    // outstanding; one decision can only settle one pending report.
    if (id !== null && pending.has(id)) {
      return;
    }

    const label = labelFor(data);
    const first = pending.size === 0;
    pending.set(id ?? `unpairable:${++unpairable}`, label);
    report(true, label);
    if (first) setStatus("blocked");
  });

  pi.events.on("permissions:decision", (data: unknown) => {
    const id = stringField(data, "requestId");
    // Decisions without a request id are supported for older event payloads;
    // a decision for an id that never prompted must not clear Herdr's state.
    const retire =
      id === null
        ? pending.keys().next().value
        : pending.has(id)
          ? id
          : undefined;

    if (retire === undefined) {
      return;
    }

    pending.delete(retire);
    report(false);
    if (pending.size === 0) setStatus("working");
  });
}
