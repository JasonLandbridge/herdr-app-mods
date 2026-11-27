import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import { createNativeTestHost } from "../over9k/native-test-host.js";
import { buildClosePlan } from "./close-plan.js";

const host = createNativeTestHost();
const closed = [];
let viewProps = { overlay: "worktree-dialog" };
let execOverride;
const launches = [];
const sidebarConfig = JSON.stringify({
  version: 1,
  machines: {
    local: {
      worktreeDirectory: "/mnt/PROJECTS/WORKTREES",
      locations: { chats: "~", projects: "~" },
      projects: { pinned: [], hidden: [], listed: [], unpinned: [] },
    },
    "unraid-dev": {
      worktreeDirectory: "/workspaces",
      locations: { chats: "~", projects: "/workspaces" },
      projects: { pinned: [], hidden: [], listed: [], unpinned: [] },
    },
  },
  repositories: {},
  options: {},
});
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => ({ ...host.gpuiBase, InputState: {}, Input: {}, Scrollbar: {} }));
mock.module("herdr", () => ({
  ...host.herdr,
  props: () => viewProps,
  closeOverlay: (id) => closed.push(id),
  readTextFile: async (path) => path.endsWith("sidebar.config.json") ? sidebarConfig : null,
  exec: async (command, args, options) => execOverride
    ? execOverride(command, args, options)
    : command === "herdr-app" ? (launches.push(JSON.parse(args[2])), { code: 0, stdout: "{}", stderr: "" })
      : { code: command === "sh" && args?.[0] === "-c" && args?.[1]?.includes("test -e") ? 1 : 0, stdout: "", stderr: "" },
}));
const { default: Worktree } = await import("./main.js");

for (const machine of [null, "unraid-dev"]) {
  test(`opening an unopened checkout starts omp on ${machine ?? "this computer"}`, () => {
    host.reset();
    closed.length = 0;
    const view = new Worktree();
    const checkout = { path: "/projects/repo feature", branch: "feature" };
    view.list = [checkout];
    view.on = machine;

    view.open(checkout);

    assert.deepEqual(closed, ["worktree-dialog"]);
    assert.deepEqual(host.calls.run, [{
      name: "space.new",
      args: { folder: checkout.path, machine: machine ?? "", argv: ["bash", "-lc", "exec omp"] },
    }]);
  });

  test(`opening an existing checkout selects its space on ${machine ?? "this computer"}`, () => {
    const checkout = { path: "/projects/repo-feature", branch: "feature" };
    host.reset({ spaces: [{ id: "existing", folder: checkout.path, machine }] });
    const view = new Worktree();
    view.list = [checkout];
    view.on = machine;

    view.open(checkout);

    assert.deepEqual(host.calls.run, [{ name: "space.select", args: { id: "existing" } }]);
  });
}
test("opening an existing checkout reveals only its hidden target and parent before selecting the space", () => {
  const checkout = { path: "/projects/repo-feature", branch: "feature" };
  host.reset({
    spaces: [{ id: "existing", folder: checkout.path, machine: null, tabs: [{ id: "tab-1" }] }],
    panes: [{ pane: "pane-1", terminal: "builder/target", tab: "tab-1", cwd: checkout.path }],
    terminals: [
      { address: "builder/target", cwd: checkout.path, parent: "builder/parent", created_ms: 22 },
      { address: "builder/parent", created_ms: 21 },
      { address: "builder/sibling", cwd: checkout.path, created_ms: 23 },
    ],
  });
  const view = new Worktree();
  view.list = [checkout];
  view.on = null;

  view.open(checkout);

  assert.deepEqual(host.calls.shared, [{
    key: "herdr-custom.agentVisibility.actions",
    value: [{ type: "reveal", addresses: ["builder/target", "builder/parent"], entries: {
      "builder/target": { created_ms: 22 },
      "builder/parent": { created_ms: 21 },
    } }],
  }]);
  assert.deepEqual(host.calls.run, [{ name: "space.select", args: { id: "existing" } }]);
});
test("opening an unopened checkout queues a pending reveal before the unchanged omp launch", () => {
  host.reset();
  closed.length = 0;
  const view = new Worktree();
  const checkout = { path: "/projects/repo feature", branch: "feature" };
  view.list = [checkout];
  view.on = null;

  view.open(checkout);

  assert.deepEqual(host.calls.shared, [{
    key: "herdr-custom.agentVisibility.actions",
    value: [{ type: "reveal-launch", machine: null, folder: checkout.path, before: [] }],
  }]);
  assert.deepEqual(host.calls.run, [{ name: "space.new", args: { folder: checkout.path, machine: "", argv: ["bash", "-lc", "exec omp"] } }]);
});
for (const machine of [null, "unraid-dev"]) {
  for (const argv of [undefined, ["codex"], ["sh"]]) {
    test(`creating a worktree defaults to OMP and preserves explicit ${argv?.[0] ?? "default"} on ${machine ?? "local"}`, async () => {
      host.reset();
      launches.length = 0;
      viewProps = { overlay: "worktree-dialog", ...(argv ? { argv } : {}) };
      const view = new Worktree();
      view.text = "feature";
      view.repo = { name: "repo", main: "/projects/repo", top: "/projects/repo" };
      view.userHome = "/home/dev";
      view.on = machine;
      assert.equal(await view.create(), "");
      assert.deepEqual(launches, [{
        folder: machine ? "/workspaces/repo-feature" : "/mnt/PROJECTS/WORKTREES/repo-feature", machine: machine ?? "",
        argv: argv ?? ["bash", "-lc", "exec omp"],
      }]);
      viewProps = { overlay: "worktree-dialog" };
    });
  }
}

test("a missing remote worktree folder fails before starting Git or opening a space", async () => {
  host.reset();
  const view = new Worktree();
  view.text = "feature";
  view.repo = { name: "repo", main: "/workspaces/repo", top: "/workspaces/repo" };
  view.on = "unraid-dev";
  const calls = [];
  execOverride = async (command, args, options) => {
    calls.push({ command, path: args.at(-1), on: options.on });
    return { code: 1, stdout: "", stderr: "" };
  };
  try {
    assert.equal(await view.create(), "New worktree folder must exist and be writable: /workspaces");
    assert.deepEqual(calls, [{ command: "sh", path: "/workspaces", on: "unraid-dev" }]);
    assert.deepEqual(host.calls.run, []);
  } finally { execOverride = undefined; }
});

test("an unsuccessful launch retries opening the created checkout without recreating it", async () => {
  host.reset();
  const view = new Worktree();
  view.text = "feature";
  view.repo = { name: "repo", main: "/projects/repo", top: "/projects/repo" };
  const opened = [];
  let adds = 0;
  execOverride = async (command, args) => {
    if (command === "herdr-app") {
      opened.push(JSON.parse(args[2]));
      return { code: 0, stdout: JSON.stringify(opened.length === 1 ? { error: "Machine disconnected" } : {}), stderr: "" };
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "add") adds++;
    return { code: command === "sh" && args[1]?.includes("test -e") ? 1 : 0, stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(() => view.create(), /Checkout created .*Machine disconnected/);
    assert.equal(await view.create(), "");
    assert.equal(adds, 1);
    assert.deepEqual(opened.map(args => args.folder), Array(2).fill("/mnt/PROJECTS/WORKTREES/repo-feature"));
  } finally { execOverride = undefined; }
});

test("existing checkout setup refuses a missing script and opens only a setup tab after review", async () => {
  const top = "/workspaces/repo-feature", main = "/workspaces/repo";
  const machine = "unraid-dev";
  host.reset({ spaces: [{ id: "remote-worktree", machine, folder: top }] });
  const view = new Worktree();
  view.on = machine;
  view.repo = { top, main };
  const plan = { hooks: [{ name: "Initialize", argv: ["bash", "/home/dev/setup.sh"], timeout_seconds: 5 }], matched: true, preflightError: "" };
  view.hookPlan = plan;
  let latest = { ...plan, preflightError: "script missing on unraid-dev" };
  view.readHooks = async () => latest;
  const commands = [];
  execOverride = async (command, args) => {
    if (command === "git" && args.includes("--show-toplevel")) return { code: 0, stdout: top };
    if (command === "git" && args.includes("--git-common-dir")) return { code: 0, stdout: `${main}/.git` };
    assert.equal(command, "herdr-app");
    commands.push([args[1], JSON.parse(args[2])]);
    return { code: 0, stdout: "{}" };
  };
  try {
    assert.match(await view.setup(), /script missing/);
    latest = plan;
    assert.match(await view.setup(), /Review them/);
    assert.deepEqual(commands, []);
    assert.equal(await view.setup(), "");
    const [[command, args]] = commands;
    assert.equal(command, "tab.new");
    assert.equal(args.space, "remote-worktree");
    assert.equal(args.folder, top);
    assert.match(args.argv[2], /\/home\/dev\/setup\.sh/);
  } finally { execOverride = undefined; }
});

test("branch cleanup requires opt-in and leases the exact origin tip", async () => {
  const folder = "/projects/repo-feature";
  const spaces = [{ id: "feature", name: "feature", folder, tabs: [] }];
  const origin = "/projects/origin.git";
  const sha = "a".repeat(40);
  for (const cleanup of [false, true]) {
    host.reset({ spaces });
    viewProps = { action: "remove", space: "feature" };
    const view = new Worktree();
    view.repo = { main: "/projects/repo", top: folder, linked: true };
    view.closePlan = buildClosePlan({ spaces: ["feature"] }, { spaces });
    view.unpushed = [];
    view.removeBranch = "feature";
    view.removeOrigin = origin;
    view.deleteLocal = view.deleteOrigin = cleanup;
    const mutations = [];
    let closeCalls = 0;
    let removeCalls = 0;
    execOverride = async (command, args) => {
      if (command === "herdr-app") {
        assert.equal(args[1], "space.close");
        closeCalls++;
        host.state.spaces = [];
        return { code: 0, stdout: "{}" };
      }
      if (args.includes("--show-toplevel")) return { code: 0, stdout: folder };
      if (args.includes("--git-common-dir")) return { code: 0, stdout: "/projects/repo/.git" };
      if (args[0] === "worktree" && cleanup && ++removeCalls === 1) return { code: 1, stderr: "Checkout busy" };
      if (["worktree", "branch", "push"].includes(args[0])) mutations.push(args);
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "feature" };
      if (args[0] === "remote") return { code: 0, stdout: origin };
      if (args[0] === "ls-remote") return { code: 0, stdout: `${sha}\trefs/heads/feature` };
      return { code: 0, stdout: "" };
    };
    try {
      if (cleanup) {
        assert.equal(await view.remove(), "Checkout busy");
        assert.deepEqual(mutations, []);
      }
      assert.equal(await view.remove(), "");
      assert.equal(closeCalls, 1);
      assert.deepEqual(mutations, [["worktree", "remove", folder], ...(cleanup ? [
        ["push", `--force-with-lease=refs/heads/feature:${sha}`, "--", origin, ":refs/heads/feature"],
        ["branch", "-d", "--", "feature"],
      ] : [])]);
    } finally { execOverride = undefined; viewProps = { overlay: "worktree-dialog" }; }
  }
});

test("worktree removal waits for close acknowledgement and retries only the reviewed checkout", async () => {
  const folder = "/projects/repo-feature";
  host.reset({ spaces: [{ id: "feature", name: "feature", folder, tabs: [] }] });
  viewProps = { action: "remove", space: "feature" };
  const view = new Worktree();
  view.repo = { main: "/projects/repo", top: folder, linked: true };
  view.closePlan = buildClosePlan({ spaces: ["feature"] }, { spaces: host.state.spaces });
  view.unpushed = [];
  view.removeBranch = "feature";
  let acknowledgeClose;
  const removals = [];
  let reachedClose;
  const closeStarted = new Promise(resolve => { reachedClose = resolve; });
  execOverride = async (command, args) => {
    if (command === "herdr-app") {
      assert.equal(args[1], "space.close");
      return new Promise(resolve => { acknowledgeClose = resolve; reachedClose(); });
    }
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "feature" };
    if (args[0] === "worktree" && args[1] === "remove") removals.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const removal = view.remove();
    await closeStarted;
    assert.deepEqual(removals, []);
    host.state.spaces = [];
    acknowledgeClose({ code: 0, stdout: "{}" });
    assert.equal(await removal, "");
    assert.deepEqual(removals, [["worktree", "remove", folder]]);
  } finally { execOverride = undefined; viewProps = { overlay: "worktree-dialog" }; }
});
