const normalizeFolder = (folder) => typeof folder === "string" ? folder.replace(/\/+$/, "") || "/" : "";

const base = (folder) => normalizeFolder(folder).split("/").pop();

function inside(folder, parent) {
  return folder === parent || parent === "/" || folder.startsWith(`${parent}/`);
}

export function machineForAddress(address) {
  const slash = typeof address === "string" ? address.indexOf("/") : -1;
  return slash > 0 ? address.slice(0, slash) : null;
}

export function folderGroupKey(machine, folder) {
  const dir = normalizeFolder(folder);
  return `${machine ? `r:${machine}:` : "d:"}${dir}`;
}

export function groupHasPassingPane(entries, byPane, passes) {
  return (entries ?? []).some(({ p }) => passes(byPane.get(p.pane)));
}

function spaceGroup(space) {
  return {
    key: space.id,
    kind: "space",
    label: space.name ?? "",
    folder: normalizeFolder(space.folder),
    machine: space.machine ?? null,
  };
}

function projectGroup(machine, folder) {
  const dir = normalizeFolder(folder);
  return {
    key: folderGroupKey(machine, dir),
    kind: "project",
    label: base(dir),
    folder: dir,
    machine: machine ?? null,
  };
}

function projectPath(project) {
  return typeof project === "string" ? project : project?.folder;
}

/**
 * Classify a pane by the folder that should own its visual row.
 * The returned owner is the real pane space; callers keep it for native focus
 * and close commands while using group for labels and visibility.
 */
export function visualGroupForPane({ pane, owner = null, spaces = [], projects = [], homeSpace = null, fallbackFolder = null }) {
  const machine = owner?.machine ?? machineForAddress(pane?.terminal);
  const cwd = normalizeFolder(pane?.cwd);
  if (!cwd) return { key: owner?.id ?? null, owner, group: owner ? spaceGroup(owner) : null, matched: Boolean(owner) };

  let bestSpace = null, bestProject = null, bestFolder = "";
  for (const space of spaces) {
    if ((space.machine ?? null) !== machine || !space.folder) continue;
    const folder = normalizeFolder(space.folder);
    if (space.id === homeSpace?.id && cwd !== folder) continue;
    if (folder.length > bestFolder.length && inside(cwd, folder)) {
      bestSpace = space;
      bestFolder = folder;
    }
  }
  for (const project of projects) {
    const folder = normalizeFolder(projectPath(project));
    if (folder.length <= bestFolder.length || !inside(cwd, folder)) continue;
    const projectMachine = project && typeof project === "object" ? project.machine ?? machine : machine;
    if ((projectMachine ?? null) !== machine) continue;
    bestProject = folder;
    bestFolder = folder;
  }
  if (bestProject || bestSpace) {
    const group = bestProject ? projectGroup(machine, bestProject) : spaceGroup(bestSpace);
    return { key: group.key, owner, group, matched: true };
  }

  const folder = normalizeFolder(fallbackFolder ?? cwd);
  if (!folder) return { key: owner?.id ?? null, owner, group: owner ? spaceGroup(owner) : null, matched: Boolean(owner) };
  const group = projectGroup(machine, folder);
  return { key: group.key, owner, group, matched: false };
}
