// Native OMP archives carry the conversation, artifacts, and image blobs.
export async function migrateAgent(terminal, target, io) {
  const source = terminal.includes("/") ? terminal.split("/")[0] : null;
  const destination = target.machine ?? null;
  const checked = async (cmd, args, on = null) => {
    const result = await io.exec(cmd, args, on ? { on } : {});
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `${cmd} failed`);
    return result.stdout?.trim() ?? "";
  };
  const details = JSON.parse(await checked("hc", ["get", terminal]));
  const labels = details.labels ?? {};
  const argv = details.foreground?.argv ?? details.argv ?? [];
  const flag = argv.findIndex(a => a === "--resume" || a === "--session" || a === "-r");
  const resumedFrom = flag >= 0 ? argv[flag + 1] : null;
  const session = labels["revive.session"] || (resumedFrom?.endsWith(".jsonl") ? resumedFrom.match(/_([^/]+)\.jsonl$/)?.[1] : resumedFrom);
  if (!session) throw new Error("OMP has not reported a saved session identity. Save the session before moving it to another machine.");
  const sessionSource = labels["revive.transcript"] || labels.transcript || resumedFrom || session;
  const machineList = JSON.parse(await checked("hc", ["machine", "ls", "--json"])).machines ?? [];
  const sshTarget = machine => {
    const entry = machineList.find(m => m.name === machine && m.state === "connected");
    if (!entry || entry.via || !entry.target || !/^[A-Za-z0-9_@.:-]+$/.test(entry.target)) throw new Error(`Machine ${machine} needs a connected SSH target for archive transfer.`);
    return entry.target;
  };
  const from = source ? sshTarget(source) : null;
  const to = destination ? sshTarget(destination) : null;
  const existing = JSON.parse(await checked("omp", ["session", "lease", "--json", "--", session], destination));
  if (existing.held?.includes(session) || existing.unknown?.includes(session)) throw new Error("Destination session ownership is already held or uncertain.");
  await checked("test", ["-d", target.folder], destination);
  const archive = `/tmp/omp-herdr-move-${Date.now()}-${terminal.replace(/[^a-z0-9]/gi, "-")}.tar`;
  let stopped = false;
  try {
    // Use literal keys: hc send wraps input in a message, not a slash command.
    await checked("hc", ["keys", terminal, "/", "e", "x", "i", "t", "enter", "enter"]);
    let released = false;
    for (let i = 0; i < 100; i++) {
      const lease = JSON.parse(await checked("omp", ["session", "lease", "--json", "--", session], source));
      if (lease.unknown?.length) throw new Error("OMP could not determine source session ownership.");
      const current = JSON.parse(await checked("hc", ["get", terminal]));
      const foreground = current.foreground;
      const stillOmp = foreground?.pid === details.foreground?.pid && /(?:^|\/)omp$/.test(foreground?.argv?.[0] || foreground?.name || "");
      if (!lease.held?.includes(session) && !stillOmp) { released = true; break; }
      await io.sleep(100);
    }
    if (!released) throw new Error("Source OMP is still running; its session was not transferred.");
    stopped = true;
    await checked("omp", ["session", "pack", sessionSource, archive], source);
    if (from) await checked("scp", ["-O", "-o", "BatchMode=yes", `${from}:${archive}`, archive]);
    if (to) await checked("scp", ["-O", "-o", "BatchMode=yes", archive, `${to}:${archive}`]);
    const output = await checked("omp", ["session", "unpack", archive, "--cwd", target.folder], destination);
    const unpacked = output.split(/\r?\n/).find(line => line.startsWith("/") && line.endsWith(".jsonl"));
    if (!unpacked) throw new Error("OMP unpack did not return an absolute session file path.");
    await checked("omp", ["session", "moved", sessionSource, "--to", destination || "local"], source);
    const result = JSON.parse(await checked("herdr-app", ["do", "tab.new", JSON.stringify({ space: target.id, folder: target.folder, argv: ["omp", "--resume", unpacked] })]));
    if (result.error) throw new Error(result.error);
    let resumed = false;
    for (let i = 0; i < 100; i++) {
      const lease = JSON.parse(await checked("omp", ["session", "lease", "--json", "--", session], destination));
      if (lease.held?.includes(session)) { resumed = true; break; }
      if (io.snapshot) {
        const now = io.snapshot();
        const space = now.spaces.find(s => s.id === target.id);
        const pane = now.panes.find(p => (space?.tabs ?? []).some(t => t.id === p.tab) && p.cwd === target.folder && now.agents.some(a => a.address === p.terminal && a.app === "omp"));
        if (pane) {
          const live = JSON.parse(await checked("hc", ["get", pane.terminal]));
          if (live.foreground?.argv?.includes(unpacked)) { resumed = true; break; }
        }
      }
      await io.sleep(100);
    }
    if (!resumed) throw new Error(`The destination has not acquired session ${session}. Inspect its new terminal before resuming the source.`);
  } catch (error) {
    throw new Error(`${error.message}${stopped ? ` Source OMP stopped; its session ${session} and any archive at ${archive} remain available for recovery. Do not resume it if the destination is running.` : ""}`);
  }
}
