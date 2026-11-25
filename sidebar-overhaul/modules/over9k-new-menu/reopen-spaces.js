const clean = path => typeof path === "string" ? path.replace(/\/+$/, "") || "/" : null;

export function reopenCandidates({ machine = null, recent = [], parked = [], scanned = [], open = [] }) {
  const opened = new Set(open.filter(s => (s.machine ?? null) === machine).map(s => clean(s.folder)));
  const entries = new Map();
  const add = (entry, source) => {
    const folder = clean(typeof entry === "string" ? entry : entry.folder ?? entry.dir);
    if (!folder || opened.has(folder)) return;
    const current = entries.get(folder);
    if (current) { if (!current.sources.includes(source)) current.sources.push(source); return; }
    entries.set(folder, { folder, name: entry.name || folder.split("/").pop() || folder, sources: [source] });
  };
  for (const entry of recent) if (!entry.machine || entry.machine === machine) add(entry, "Recent");
  for (const entry of parked) add(entry, "Parked");
  for (const entry of scanned) add(entry, "Workspace");
  return [...entries.values()];
}
