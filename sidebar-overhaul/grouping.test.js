import assert from "node:assert/strict";
import { test } from "node:test";
import { groupHasPassingPane, visualGroupForPane } from "./grouping.js";

const remoteHome = (machine, id = `${machine}/sp-home`) => ({
  id,
  machine,
  folder: "/home/dev",
  name: "~",
});

const localHome = { id: "sp-home", machine: null, folder: "/home/jason", name: "~" };

test("remote Home owner keeps native ownership while its MusicBumble pane gets a visual project group", () => {
  const owner = remoteHome("unraid-dev", "unraid-dev/sp-home");
  const pane = { terminal: "unraid-dev/t2", cwd: "/workspaces/MusicBumble" };
  const result = visualGroupForPane({ pane, owner, spaces: [owner], projects: [], fallbackFolder: pane.cwd });

  assert.equal(result.owner, owner);
  assert.equal(result.key, "r:unraid-dev:/workspaces/MusicBumble");
  assert.deepEqual(result.group, {
    key: "r:unraid-dev:/workspaces/MusicBumble",
    kind: "project",
    label: "MusicBumble",
    folder: "/workspaces/MusicBumble",
    machine: "unraid-dev",
  });
});

test("remote visual group remains selectable when its pane passes the Agents filter", () => {
  const owner = remoteHome("unraid-dev", "unraid-dev/sp-home");
  const pane = { terminal: "unraid-dev/t2", cwd: "/workspaces/MusicBumble" };
  const result = visualGroupForPane({ pane, owner, spaces: [owner], projects: [], fallbackFolder: pane.cwd });
  const entries = [{ p: { pane: "pane-music" } }];
  const byPane = new Map([["pane-music", { status: "working" }]]);

  assert.equal(result.key, "r:unraid-dev:/workspaces/MusicBumble");
  assert.equal(groupHasPassingPane(entries, byPane, (agent) => agent?.status === "working"), true);
  assert.equal(groupHasPassingPane(entries, byPane, (agent) => agent?.status === "done"), false);
});

test("same path candidates on other machines cannot capture a remote pane, but a target-machine space can", () => {
  const folder = "/workspaces/MusicBumble";
  const owner = remoteHome("unraid-dev");
  const local = { id: "sp-local-music", machine: null, folder, name: "MusicBumble" };
  const other = { id: "buildbox/sp-music", machine: "buildbox", folder, name: "MusicBumble" };
  const target = { id: "unraid-dev/sp-music", machine: "unraid-dev", folder, name: "MusicBumble" };
  const pane = { terminal: "unraid-dev/t2", cwd: `${folder}/src` };
  const noTargetSpace = visualGroupForPane({ pane, owner, spaces: [local, other, owner], projects: [], fallbackFolder: pane.cwd });
  const targetSpace = visualGroupForPane({ pane, owner, spaces: [local, other, owner, target], projects: [], fallbackFolder: pane.cwd });

  assert.equal(noTargetSpace.key, "r:unraid-dev:/workspaces/MusicBumble/src");
  assert.equal(targetSpace.key, target.id);
  assert.notEqual(noTargetSpace.key, local.id);
  assert.notEqual(noTargetSpace.key, other.id);
});

test("same-folder spaces keep first native space and prefer it over an exact-path project", () => {
  const folder = "/workspaces/MusicBumble";
  const first = { id: "unraid-dev/sp-first", machine: "unraid-dev", folder, name: "MusicBumble" };
  const second = { id: "unraid-dev/sp-second", machine: "unraid-dev", folder, name: "MusicBumble" };
  const result = visualGroupForPane({
    pane: { terminal: "unraid-dev/t2", cwd: folder },
    owner: remoteHome("unraid-dev"),
    spaces: [first, second],
    projects: [folder],
    fallbackFolder: folder,
  });

  assert.equal(result.key, first.id);
});

test("local project and home grouping keeps the existing space and loose-folder rules", () => {
  const project = { id: "sp-reaparr", machine: null, folder: "/mnt/PROJECTS/Reaparr", name: "Reaparr" };
  const inProject = visualGroupForPane({
    pane: { terminal: "t-reaparr", cwd: "/mnt/PROJECTS/Reaparr/src" },
    owner: project,
    spaces: [localHome, project],
    projects: ["/mnt/PROJECTS/Reaparr"],
    homeSpace: localHome,
  });
  const loose = visualGroupForPane({
    pane: { terminal: "t-scripts", cwd: "/home/jason/Scripts" },
    owner: localHome,
    spaces: [localHome],
    projects: [],
    homeSpace: localHome,
  });

  assert.equal(inProject.key, project.id);
  assert.equal(loose.key, "d:/home/jason/Scripts");
});

test("missing foreground metadata does not override a pane cwd, and missing cwd keeps its owner", () => {
  const owner = remoteHome("unraid-dev", "unraid-dev/sp-home");
  const terminalWithoutForeground = { address: "unraid-dev/t2", cwd: "/home/dev" };
  const grouped = visualGroupForPane({
    pane: { terminal: terminalWithoutForeground.address, cwd: "/workspaces/MusicBumble" },
    owner,
    spaces: [owner],
    fallbackFolder: "/workspaces/MusicBumble",
  });
  const unchanged = visualGroupForPane({ pane: { terminal: terminalWithoutForeground.address, cwd: null }, owner, spaces: [owner] });

  assert.equal(grouped.key, "r:unraid-dev:/workspaces/MusicBumble");
  assert.equal(unchanged.key, owner.id);
  assert.equal(unchanged.owner, owner);
});
