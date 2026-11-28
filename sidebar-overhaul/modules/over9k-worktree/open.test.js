import assert from "node:assert/strict";
import { test } from "node:test";
import { mock } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeTestHost, textOf, trigger } from "../over9k/native-test-host.js";
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
mock.module("gpui-base", () => ({ ...host.gpuiBase, InputState: { new: () => ({ on() {}, focus() {} }) }, Input: {}, Scrollbar: {} }));
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

const removalHead = "a".repeat(40);
const registration = (main, folder, branch = "feature", head = removalHead, flags = []) =>
  [`worktree ${main}\0bare`, [`worktree ${folder}`, `HEAD ${head}`, branch ? `branch refs/heads/${branch}` : "detached", ...flags].join("\0"), ""].join("\0\0");

function removalGit(args, { main, top }, branch = "feature", head = removalHead) {
  if (args.includes("--show-toplevel")) return { code: 0, stdout: top };
  if (args.includes("--git-common-dir")) return { code: 0, stdout: `${main}/.git` };
  if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: registration(main, top, branch, head) };
  if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: head };
}

function reviewedRemoval(view) {
  view.removalCheckout = { id: "feature", path: view.repo.top, main: view.repo.main, branch: "feature", head: removalHead };
}

test("branch cleanup requires opt-in and leases the exact origin tip", async () => {
  const folder = "/projects/repo-feature";
  const spaces = [{ id: "feature", name: "feature", folder, tabs: [] }];
  const origin = "/projects/origin.git";
  const sha = "a".repeat(40);
  for (const [local, remote] of [[false, false], [true, false], [false, true], [true, true]]) {
    host.reset({ spaces });
    viewProps = { action: "remove", space: "feature" };
    const view = new Worktree();
    view.repo = { main: "/projects/repo", top: folder, linked: true };
    view.closePlan = buildClosePlan({ spaces: ["feature"] }, { spaces });
    reviewedRemoval(view);
    view.unpushed = [];
    view.removeOrigin = origin;
    view.deleteLocal = local;
    view.deleteOrigin = remote;
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
      const read = removalGit(args, view.repo);
      if (read) return read;
      if (args[0] === "worktree" && local && remote && ++removeCalls === 1) return { code: 1, stderr: "Checkout busy" };
      if (["worktree", "branch", "push"].includes(args[0])) mutations.push(args);
      assert.notEqual(args[0], "symbolic-ref", "cleanup must use the registered branch");
      if (args[0] === "remote") {
        assert.equal(remote, true, "local-only cleanup must not query origin");
        return { code: 0, stdout: origin };
      }
      if (args[0] === "ls-remote") return { code: 0, stdout: `ref: refs/heads/dev\tHEAD\n${sha}\trefs/heads/feature` };
      return { code: 0, stdout: "" };
    };
    try {
      if (local && remote) {
        assert.equal(await view.remove(), "Checkout busy");
        assert.deepEqual(mutations, []);
      }
      assert.equal(await view.remove(), "");
      assert.equal(closeCalls, 1);
      assert.deepEqual(mutations, [["worktree", "remove", folder],
        ...(remote ? [["push", `--force-with-lease=refs/heads/feature:${sha}`, "--", origin, ":refs/heads/feature"]] : []),
        ...(local ? [["branch", "-d", "--", "feature"]] : [])]);
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
  reviewedRemoval(view);
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
    const read = removalGit(args, view.repo);
    if (read) return read;
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

test("removal cleans residual IDE files without deleting a replacement checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-remove-"));
  const folder = join(root, "checkout");
  const spaces = [{ id: "feature", name: "feature", folder, tabs: [] }];
  host.reset({ spaces });
  viewProps = { action: "remove", space: "feature" };
  const view = new Worktree();
  view.repo = { main: join(root, "repo"), top: folder, linked: true };
  view.closePlan = buildClosePlan({ spaces: ["feature"] }, { spaces });
  reviewedRemoval(view);
  view.unpushed = [];
  view.removeBranch = "feature";
  let gitRemovals = 0;
  execOverride = async (command, args) => {
    if (command === "herdr-app") {
      host.state.spaces = [];
      return { code: 0, stdout: "{}" };
    }
    if (command === "sh") {
      const result = Bun.spawnSync([command, ...args]);
      return { code: result.exitCode, stderr: result.stderr.toString() };
    }
    const read = removalGit(args, view.repo);
    if (read) return read;
    if (args[0] === "worktree" && args[1] === "remove") gitRemovals++;
    return { code: 0, stdout: "" };
  };
  try {
    await mkdir(join(folder, ".idea"), { recursive: true });
    await writeFile(join(folder, ".idea", "workspace.xml"), "IDE state");
    await writeFile(join(folder, ".git"), "replacement checkout");
    assert.match(await view.remove(), /refusing to delete/);
    assert.equal((await stat(join(folder, ".idea", "workspace.xml"))).isFile(), true);
    await rm(join(folder, ".git"));
    assert.equal(await view.remove(), "");
    await assert.rejects(stat(folder), { code: "ENOENT" });
    assert.equal(gitRemovals, 1);
  } finally {
    execOverride = undefined;
    viewProps = { overlay: "worktree-dialog" };
    await rm(root, { recursive: true, force: true });
  }
});

// Exercise the dialog initialization and confirmation together. The earlier
// command-only tests supplied a branch by hand and missed the wrong-source bug.
const removalScenarios = {
  "wrong pane directory": "", detached: "",
  "duplicate registration": /exact registered linked worktree/, "space changed machine": /selected space changed/,
  "main checkout": /root of a linked worktree/, "missing registration": /exact registered linked worktree/,
  "registration unreadable": /unreadable registrations/, locked: /not usable/, prunable: /not usable/,
  "invalid HEAD": /exact branch and commit/, "missing branch": /exact branch and commit/,
  "space moved": /selected space changed/, "checkout replaced": /checkout changed/,
  "space moved during origin lookup": /selected space changed/,
  "branch changed": /branch or commit changed/, "commit changed": /branch or commit changed/,
  "branch changed during close": /branch or commit changed/, "close rejected": /could not confirm/i,
  "space still open": /still open/, "origin changed": /push destination changed/, "default branch": /default branch \(corrections\)/,
  "space reopened during removal": /still open/,
  "origin unavailable": /origin offline/, "default unknown": /Could not verify the default branch/,
  "origin tip invalid": /Could not verify the origin branch tip/, "origin tip moved": /Origin branch kept: its tip changed/,
  "local tip moved": /Local branch kept: its tip/, "origin push rejected": /Origin branch kept: rejected/,
  "local delete rejected": /Local branch kept: not merged/, "absent origin branch": "",
  "status failed": /status unavailable/, "new dirty files": /Review the warnings/,
};
for (const [scenario, expected] of Object.entries(removalScenarios)) {
  test(`worktree removal: ${scenario}`, async () => {
    const folder = "/workspaces/Reaparr.git-corrections", dev = "/workspaces/Reaparr-dev", main = "/workspaces/store.git";
    const id = "unraid-dev/corrections", machine = "unraid-dev", origin = "/fixture/origin.git";
    const branch = scenario === "detached" ? null : "corrections";
    const mutations = [];
    let confirmed = false, closed = false;
    let retry = false;
    host.reset({ spaces: [{ id, machine, folder, name: "corrections", tabs: [{ id: "tab" }] }], panes: [{ tab: "tab", cwd: dev }] });
    viewProps = { action: "remove", space: id };
    execOverride = async (command, args, { cwd, on } = {}) => {
      if (command === "herdr-app") {
        assert.equal(args[1], "space.close");
        assert.deepEqual(JSON.parse(args[2]), { id, confirmed: true });
        mutations.push("close");
        if (scenario === "close rejected") return { code: 1, stderr: "refused" };
        if (scenario !== "space still open") host.state.spaces = [];
        closed = true;
        return { code: 0, stdout: "{}" };
      }
      assert.equal(on, machine);
      if (command === "sh") return { code: 0, stdout: "/home/dev" };
      assert.notEqual(cwd, dev, "never inspect the pane’s dev checkout");
      if (args.includes("--show-toplevel")) return { code: 0, stdout: scenario === "main checkout" ? main : folder };
      if (args.includes("--git-common-dir")) return { code: 0, stdout: confirmed && scenario === "checkout replaced" ? "/workspaces/replacement.git" : main };
      if (args[0] === "worktree" && args[1] === "list") {
        if (scenario === "registration unreadable") return { code: 1, stderr: "unreadable registrations" };
        const ref = (confirmed && scenario === "branch changed") || (closed && scenario === "branch changed during close") ? "dev" : branch;
        const head = scenario === "invalid HEAD" ? "invalid" : confirmed && scenario === "commit changed" ? "b".repeat(40) : removalHead;
        const flags = ["locked", "prunable"].includes(scenario) ? [scenario] : [];
        if (closed && scenario === "space reopened during removal") host.state.spaces = [{ id: "replacement", machine, folder }];
        const output = registration(main, scenario === "missing registration" ? dev : folder, ref, head, flags);
        if (scenario === "duplicate registration") return { code: 0, stdout: output + output };
        return { code: 0, stdout: scenario === "missing branch" ? output.replace("branch refs/heads/corrections\0", "\0") : output };
      }
      if (confirmed && args.includes("status")) {
        if (scenario === "status failed") return { code: 1, stderr: "status unavailable" };
        if (scenario === "new dirty files") return { code: 0, stdout: "?? untracked" };
      }
      if (args[0] === "remote") return { code: 0, stdout: confirmed && scenario === "origin changed" ? "/other/origin.git" : origin };
      if (args[0] === "ls-remote") {
        if (scenario === "space moved during origin lookup") host.state.spaces[0].folder = dev;
        if (scenario === "origin unavailable") return { code: 1, stderr: "origin offline" };
        const defaultRef = scenario === "default branch" || (retry && scenario === "origin push rejected") ? "corrections" : "dev";
        const tip = scenario === "origin tip invalid" ? "broken" : closed && scenario === "origin tip moved" ? "b".repeat(40) : removalHead;
        const refLine = scenario === "absent origin branch" ? "" : `${tip}\trefs/heads/corrections`;
        return { code: 0, stdout: `${scenario === "default unknown" ? "" : `ref: refs/heads/${defaultRef}\tHEAD\n`}${refLine}` };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        assert.equal(args[2], "refs/heads/corrections");
        return { code: 0, stdout: scenario === "local tip moved" ? "b".repeat(40) : removalHead };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        assert.equal(args.at(-1), folder);
        mutations.push("remove");
      } else if (args[0] === "push") {
        assert.equal(args.at(-1), ":refs/heads/corrections");
        mutations.push("push corrections");
        if (scenario === "origin push rejected") return { code: 1, stderr: "rejected" };
      } else if (args[0] === "branch") {
        assert.equal(args.at(-1), "corrections");
        mutations.push("delete corrections");
        if (scenario === "local delete rejected") return { code: 1, stderr: "not merged" };
      }
      return { code: 0, stdout: "" };
    };
    const pending = [];
    const context = { ...host.context(), focus_handle: () => ({ focus() {} }), spawn: fn => pending.push(fn(context)) };
    try {
      const view = new Worktree();
      view.init(viewProps, context);
      await Promise.all(pending);
      confirmed = true;
      if (scenario === "space moved") host.state.spaces[0].folder = dev;
      if (scenario === "space changed machine") host.state.spaces[0].machine = "other-machine";
      if (scenario === "wrong pane directory") {
        const dialog = view.render(context);
        assert.match(textOf(dialog), /Branch: corrections/);
        assert.doesNotMatch(textOf(dialog), /Branch: dev/);
        trigger(dialog, "worktree-delete-local", "click", {}, context);
        trigger(view.render(context), "worktree-delete-origin", "click", {}, context);
        trigger(view.render(context), "worktree-remove-yes", "click", {}, context);
        await pending.at(-1);
      } else {
        view.deleteLocal = view.deleteOrigin = Boolean(branch);
        await view.work(context);
      }
      if (expected) assert.match(view.error, expected);
      else assert.equal(view.error, "");
      if (!expected || ["origin tip moved", "local tip moved", "origin push rejected", "local delete rejected"].includes(scenario)) {
        assert.deepEqual(mutations, ["close", "remove",
          ...(!["detached", "origin tip moved", "absent origin branch"].includes(scenario) ? ["push corrections"] : []),
          ...(!["detached", "local tip moved"].includes(scenario) ? ["delete corrections"] : [])]);
      } else assert.deepEqual(mutations, ["space reopened during removal"].includes(scenario) ? ["close", "remove"]
        : ["branch changed during close", "close rejected", "space still open"].includes(scenario) ? ["close"] : []);
      if (scenario === "origin push rejected") {
        retry = true;
        const before = [...mutations];
        await view.work(context);
        assert.match(view.error, /Refusing to delete origin’s default branch \(corrections\)/);
        assert.deepEqual(mutations, before, "retry must not push or repeat successful local cleanup");
      }
    } finally { execOverride = undefined; viewProps = { overlay: "worktree-dialog" }; }
  });
}

test("real Git removes corrections and preserves dev when the corrections pane is in dev", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-delete-"));
  const origin = join(root, "origin.git"), store = join(root, "store.git");
  const dev = join(root, "dev"), corrections = join(root, "corrections");
  const id = "corrections";
  const git = (args, cwd = root) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const checked = (args, cwd) => {
    const result = git(args, cwd);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    checked(["init", "--bare", "-b", "dev", origin]);
    checked(["init", "--bare", "-b", "dev", store]);
    const tree = checked(["mktree"], store);
    const tip = checked(["commit-tree", tree, "-m", "base"], store);
    checked(["update-ref", "refs/heads/dev", tip], store);
    checked(["branch", "corrections", "dev"], store);
    checked(["remote", "add", "origin", origin], store);
    checked(["push", "origin", "dev", "corrections"], store);
    checked(["worktree", "add", dev, "dev"], store);
    checked(["worktree", "add", corrections, "corrections"], store);
    host.reset({ spaces: [{ id, folder: corrections, tabs: [{ id: "tab" }] }], panes: [{ tab: "tab", cwd: dev }] });
    viewProps = { action: "remove", space: id };
    execOverride = async (command, args, { cwd } = {}) => {
      if (command === "git") return git(args, cwd);
      if (command === "herdr-app") {
        assert.deepEqual(JSON.parse(args[2]), { id, confirmed: true });
        host.state.spaces = [];
        return { code: 0, stdout: "{}" };
      }
      assert.equal(command, "sh");
      assert.equal(args.at(-1), corrections);
      return { code: 0 };
    };
    const pending = [];
    const cx = { ...host.context(), focus_handle: () => ({ focus() {} }), spawn: fn => pending.push(fn(cx)) };
    const view = new Worktree();
    view.init(viewProps, cx);
    await Promise.all(pending);
    assert.equal(view.error, "");
    view.deleteLocal = view.deleteOrigin = true;
    await view.work(cx);
    assert.equal(view.error, "");
    for (const repo of [store, origin]) {
      assert.equal(checked(["rev-parse", "--verify", "refs/heads/dev"], repo), tip);
      assert.notEqual(git(["show-ref", "--verify", "--quiet", "refs/heads/corrections"], repo).code, 0);
    }
    assert.equal(checked(["symbolic-ref", "HEAD"], dev), "refs/heads/dev");
    await assert.rejects(stat(corrections), { code: "ENOENT" });
  } finally {
    execOverride = undefined;
    viewProps = { overlay: "worktree-dialog" };
    await rm(root, { recursive: true, force: true });
  }
});
