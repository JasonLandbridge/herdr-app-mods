import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import { createNativeTestHost } from "../over9k/native-test-host.js";

const host = createNativeTestHost();
const closed = [];
let viewProps = { overlay: "worktree-dialog" };
let execOverride;
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
      viewProps = { overlay: "worktree-dialog", ...(argv ? { argv } : {}) };
      const view = new Worktree();
      view.text = "feature";
      view.repo = { name: "repo", main: "/projects/repo", top: "/projects/repo" };
      view.userHome = "/home/dev";
      view.on = machine;
      assert.equal(await view.create(), "");
      assert.deepEqual(host.calls.run, [{ name: "space.new", args: {
        folder: machine ? "/workspaces/repo-feature" : "/mnt/PROJECTS/WORKTREES/repo-feature", machine: machine ?? "", tab: undefined,
        argv: argv ?? ["bash", "-lc", "exec omp"],
      } }]);
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
