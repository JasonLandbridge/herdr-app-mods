import assert from "node:assert/strict";
import { test } from "node:test";
import { moveAgent, moveTargets, discoverWorktrees } from "./move-agent.js";

function fixture({ status = "idle", failMove = false } = {}) {
  const state = {
    spaces: [
      { id: "source", machine: null, tabs: [{ id: "source-tab" }] },
      { id: "target", machine: null, folder: "/stale", tabs: [{ id: "target-tab" }] },
      { id: "remote", machine: "remote", folder: "/remote" },
    ],
    panes: [
      { terminal: "t-agent", tab: "source-tab", cwd: "/source" },
      { terminal: "t-target", tab: "target-tab", cwd: "/target with spaces" },
    ],
    agents: [{ address: "t-agent", app: "omp", status, space: "source" }],
    terminals: [{ address: "t-agent", state: "live", agent: "omp" }],
  };
  const calls = [];
  let parked = false;
  const io = {
    snapshot: () => state,
    sleep: async () => { if (parked) state.panes = state.panes.filter(p => p.terminal !== "t-agent"); },
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "hc") {
        if (args[0] === "keys" && failMove) return { code: 1, stderr: "not idle" };
        return { code: 0, stdout: args[0] === "get" ? JSON.stringify({ foreground: { cwd: "/target with spaces" } }) : "{}" };
      }
      if (args[1] === "terminal.park") parked = true;
      if (args[1] === "terminal.keep") {
        assert.equal(state.panes.some(p => p.terminal === "t-agent"), false, "keep waits for park completion");
        state.panes.push({ terminal: "t-agent", tab: "target-tab" });
      }
      return { code: 0, stdout: "{}" };
    },
  };
  return { state, io, calls };
}

test("worktree discovery uses the configured root on the connected machine", async () => {
  const calls = [];
  const targets = await discoverWorktrees("remote", { root: "/workspaces", exec: async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { code: 0, stdout: "worktree /workspaces/Reaparr\nworktree /workspaces/MusicBumble\n" };
  } });
  assert.equal(calls[0].cmd, "sh");
  assert.equal(calls[0].args.at(-1), "/workspaces");
  assert.deepEqual(targets.map((target) => target.folder), ["/workspaces/Reaparr", "/workspaces/MusicBumble"]);
  assert.deepEqual(calls[0].options, { on: "remote" });
});

test("discovered worktrees merge with spaces and dedupe normalized folders", async () => {
  const { state } = fixture();
  const discovered = [{ id: "worktree:remote:/remote/", machine: "remote", folder: "/remote/", discovered: true }, { id: "new", machine: "remote", folder: "/new" }];
  assert.deepEqual(moveTargets("t-agent", { ...state, discovered }).map((target) => [target.id, target.folder]), [["target", "/target with spaces"], ["remote", "/remote"], ["new", "/new"]]);
});
test("OMP destinations include local and remote spaces with live folders", () => {
  const { state } = fixture();
  assert.deepEqual(moveTargets("t-agent", state).map(s => [s.id, s.folder]), [["target", "/target with spaces"], ["remote", "/remote"]]);
});

test("OMP destinations include recent and parked folders not currently open", () => {
  const { state } = fixture();
  const discovered = [
    { id: "recent-parked:local:/recent", folder: "/recent", name: "Recent", sources: ["Recent"], machine: null, discovered: true },
    { id: "recent-parked:local:/parked", folder: "/parked", name: "Parked", sources: ["Parked"], machine: null, discovered: true },
    { id: "recent-parked:local:/target with spaces", folder: "/target with spaces", name: "Duplicate", sources: ["Recent"], machine: null, discovered: true },
  ];
  assert.deepEqual(moveTargets("t-agent", { ...state, discovered }).map(s => [s.id, s.folder]), [
    ["target", "/target with spaces"],
    ["remote", "/remote"],
    ["recent-parked:local:/recent", "/recent"],
    ["recent-parked:local:/parked", "/parked"],
  ]);
});
test("move changes OMP cwd before relocating the same running terminal", async () => {
  const { io, calls, state } = fixture();
  await moveAgent("t-agent", "target", io);
  assert.equal(calls[0][0], "hc");
  assert.equal(calls[0][1], "keys");
  assert.equal(calls[0][2], "t-agent");
  assert.equal(calls[0].slice(3, -2).map(k => k === "space" ? " " : k).join(""), "/move /target with spaces");
  assert.deepEqual(calls[0].slice(-2), ["enter", "enter"]);
  assert.deepEqual(calls.filter(c => c[0] === "herdr-app").map(c => [c[2], JSON.parse(c[3])]), [
    ["terminal.park", { terminal: "t-agent" }],
    ["space.select", { id: "target" }],
    ["terminal.keep", { terminal: "t-agent" }],
  ]);
  assert.ok(state.panes.some(p => p.terminal === "t-agent" && p.tab === "target-tab"));
});

for (const status of ["working", "blocked"]) test(`refuses ${status} agents without touching their terminal`, async () => {
  const { io, calls } = fixture({ status });
  await assert.rejects(moveAgent("t-agent", "target", io), /Wait for the agent/);
  assert.deepEqual(calls, []);
});

test("rejected OMP move leaves terminal ownership unchanged", async () => {
  const { io, calls, state } = fixture({ failMove: true });
  await assert.rejects(moveAgent("t-agent", "target", io), /not idle/);
  assert.equal(calls.some(c => c[0] === "herdr-app"), false);
  assert.equal(state.panes.find(p => p.terminal === "t-agent").tab, "source-tab");
});

test("non-OMP agents cannot move between machines", async () => {
  const { io, calls, state } = fixture();
  state.agents[0].app = "claude";
  state.terminals[0].agent = "claude";
  await assert.rejects(moveAgent("t-agent", "remote", io), /available destination/);
  assert.deepEqual(calls, []);
});

test("remote same-machine move keeps qualified terminal and space identities", async () => {
  const { state, calls, io } = fixture();
  state.spaces = state.spaces.slice(0, 2).map(s => ({ ...s, id: `remote/${s.id}`, machine: "remote" }));
  state.agents[0].address = "remote/t-agent";
  state.agents[0].space = "remote/source";
  state.terminals[0].address = "remote/t-agent";
  state.panes[0].terminal = "remote/t-agent";
  const original = io.exec;
  io.exec = async (cmd, args) => {
    if (cmd === "herdr-app" && args[1] === "terminal.park") state.panes = state.panes.filter(p => p.terminal !== "remote/t-agent");
    if (cmd === "herdr-app" && args[1] === "terminal.keep") {
      state.panes.push({ terminal: "remote/t-agent", tab: "target-tab" });
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "{}" };
    }
    return original(cmd, args);
  };
  await moveAgent("remote/t-agent", "remote/target", io);
  assert.ok(calls.some(c => c[2] === "space.select" && JSON.parse(c[3]).id === "remote/target"));
  assert.equal(calls[0][2], "remote/t-agent");
});
