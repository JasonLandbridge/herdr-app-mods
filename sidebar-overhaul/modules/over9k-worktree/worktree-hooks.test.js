import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorktree, hookGateRetryScript, hookGateScript, hookPlan, WORKTREE_LABELS } from "./worktree-hooks.js";

async function fixture() {
  const userHome = await mkdtemp(join(tmpdir(), "herdr-worktree-"));
  const repo = { main: join(userHome, "Reaparr"), top: join(userHome, "Reaparr"), name: "Reaparr" };
  const config = {
    version: 1,
    machines: {
      local: {
        worktreeDirectory: join(userHome, ".herdr", "worktrees"),
        locations: { chats: "~", projects: "~" },
        projects: { pinned: [], hidden: [], listed: [], unpinned: [] },
      },
      "unraid-dev": {
        worktreeDirectory: join(userHome, "remote-worktrees"),
        locations: { chats: "~", projects: "~" },
        projects: { pinned: [], hidden: [], listed: [], unpinned: [] },
      },
    },
    repositories: {},
    options: {},
  };
  return { userHome, repo, config };
}

function gitStub(events, checkoutPath) {
  return async (cwd, args, machine, timeout) => {
    events.push({ type: "git", cwd, args, machine, timeout });
    if (args[0] === "show-ref") return { ok: false, out: "", err: "" };
    if (args[0] === "worktree") {
      await mkdir(checkoutPath, { recursive: true });
      return { ok: true, out: "", err: "" };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };
}

function runGate(argv, cwd, input = "", overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, HC_TERMINAL_ID: "", SHELL: "sh", ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function exists(path) {
  try { await stat(path); return true; }
  catch { return false; }
}

const plan = (hooks) => ({ hooks, matched: true });

test("hook gates execute lifecycle labels without letting label failures affect setup", async () => {
  const { userHome } = await fixture();
  const checkoutPath = join(userHome, "label-fixture");
  const fakeBin = join(userHome, "fake-bin");
  await mkdir(checkoutPath, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await symlink("/usr/bin/touch", join(fakeBin, "hc"));
  const environment = { HC_TERMINAL_ID: "fixture-terminal", PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
  const metadata = { repo: "/repo", cwd: "/checkout" };
  const first = await runGate(
    ["sh", "-c", hookGateScript([{ name: "setup", argv: ["sh", "-c", "exit 7"], timeout_seconds: 10 }], ["sh", "-c", "true"], metadata), "herdr-label-gate"],
    checkoutPath,
    "",
    environment,
  );
  assert.equal(first.code, 0);
  assert.equal(await exists(join(checkoutPath, `${WORKTREE_LABELS.status}=running`)), true);
  assert.equal(await exists(join(checkoutPath, `${WORKTREE_LABELS.status}=failed`)), true);
  assert.equal(await exists(join(checkoutPath, `${WORKTREE_LABELS.exitreason}=hook_exit_7`)), true);

  const retry = await runGate(
    ["sh", "-c", hookGateRetryScript([{ name: "setup", argv: ["sh", "-c", "true"], timeout_seconds: 10 }], ["sh", "-c", "true"], metadata), "herdr-label-retry"],
    checkoutPath,
    "",
    environment,
  );
  assert.equal(retry.code, 0);
  assert.equal(await exists(join(checkoutPath, `${WORKTREE_LABELS.status}=retrying`)), true);
  assert.equal(await exists(join(checkoutPath, `${WORKTREE_LABELS.status}=succeeded`)), true);
  assert.equal(await exists(join(checkoutPath, `${WORKTREE_LABELS.exitreason}=success`)), true);
});

test("creation runs git before a visible hook gate and keeps the new checkout cwd", async () => {
  const { userHome, repo, config } = await fixture();
  const checkoutPath = join(userHome, ".herdr", "worktrees", "Reaparr-feature-cwd");
  const events = [];
  let launch;
  const result = await createWorktree({
    branch: "feature/cwd",
    repo,
    config,
    userHome,
    machine: null,
    pathExists: async () => false,
    tab: "tab-1",
    requestedArgv: ["sh", "-c", "test \"$(cat sequence.txt)\" = second && pwd > requested-cwd.txt"],
    git: gitStub(events, checkoutPath),
    readHooks: (context) => { events.push({ type: "config", context }); return plan([
      { name: "cwd", argv: ["sh", "-c", "pwd > hook-cwd.txt"], timeout_seconds: 10 },
      { name: "sequential", argv: ["sh", "-c", "test -s hook-cwd.txt && printf second > sequence.txt"], timeout_seconds: 10 },
    ]); },
    runSpace: (args) => { launch = args; events.push({ type: "space", args }); },
  });
  assert.equal(result, "");
  assert.deepEqual(events.map((event) => event.type), ["config", "git", "git", "space"]);
  assert.deepEqual(launch.argv.slice(0, 2), ["sh", "-c"]);
  assert.equal(launch.folder, checkoutPath);
  const gate = await runGate(launch.argv, launch.folder);
  assert.equal(gate.code, 0);
  assert.equal((await readFile(join(checkoutPath, "hook-cwd.txt"), "utf8")).trim(), checkoutPath);
  assert.equal((await readFile(join(checkoutPath, "sequence.txt"), "utf8")), "second");
  assert.equal((await readFile(join(checkoutPath, "requested-cwd.txt"), "utf8")).trim(), checkoutPath);
});
test("without requested argv, hook success hands the checkout back to the normal shell instead of forcing OMP", async () => {
  const { userHome, repo, config } = await fixture();
  const checkoutPath = join(userHome, ".herdr", "worktrees", "Reaparr-shell");
  let launch;
  const result = await createWorktree({
    branch: "shell",
    repo,
    config,
    userHome,
    machine: null,
    pathExists: async () => false,
    requestedArgv: undefined,
    git: gitStub([], checkoutPath),
    readHooks: () => plan([{ name: "shell setup", argv: ["sh", "-c", "printf setup > setup.txt"], timeout_seconds: 10 }]),
    runSpace: (args) => { launch = args; },
  });
  assert.equal(result, "");
  const gate = await runGate(launch.argv, launch.folder, "printf ready > shell-ready.txt\npwd > shell-cwd.txt\nexit\n");
  assert.equal(gate.code, 0);
  assert.equal(await readFile(join(checkoutPath, "setup.txt"), "utf8"), "setup");
  assert.equal(await readFile(join(checkoutPath, "shell-ready.txt"), "utf8"), "ready");
  assert.equal((await readFile(join(checkoutPath, "shell-cwd.txt"), "utf8")).trim(), checkoutPath);
});

test("a non-matching rule runs the requested program without running that rule's hook", async () => {
  const { userHome, repo, config } = await fixture();
  const checkoutPath = join(userHome, ".herdr", "worktrees", "Reaparr-plain");
  const requestedArgv = ["sh", "-c", "printf requested > requested.txt"];
  let launch;
  const hooksConfig = JSON.stringify({ version: 2, projects: [{ machine: "other", repo: repo.main, hooks: { on_created: [{ name: "other", argv: ["sh", "-c", "printf hook > hook.txt"], timeout_seconds: 1 }] } }] });
  const result = await createWorktree({
    branch: "plain",
    repo,
    config,
    userHome,
    machine: null,
    pathExists: async () => false,
    requestedArgv,
    git: gitStub([], checkoutPath),
    readHooks: ({ machine, main }) => hookPlan(hooksConfig, machine, main),
    runSpace: (args) => { launch = args; },
  });
  assert.equal(result, "");
  assert.deepEqual(launch.argv, requestedArgv);
  const gate = await runGate(launch.argv, launch.folder);
  assert.equal(gate.code, 0);
  assert.equal(await readFile(join(checkoutPath, "requested.txt"), "utf8"), "requested");
  assert.equal(await exists(join(checkoutPath, "hook.txt")), false);
});
test("malformed matching config, including an empty executable, blocks git worktree creation before an orphan checkout can exist", async () => {
  const { userHome, repo, config } = await fixture();
  const events = [];
  const malformed = JSON.stringify({ version: 2, projects: [{ machine: null, repo: repo.main, hooks: { on_created: [{ name: "bad", argv: [""], timeout_seconds: 1 }] } }] });
  let launches = 0;
  const result = await createWorktree({
    branch: "blocked",
    repo,
    config,
    userHome,
    machine: null,
    pathExists: async () => false,
    requestedArgv: ["agent"],
    git: gitStub(events, join(userHome, ".herdr", "worktrees", "Reaparr-blocked")),
    readHooks: ({ machine, main }) => hookPlan(malformed, machine, main),
    runSpace: () => { launches += 1; },
  });
  assert.match(result, /Invalid worktree hooks config/);
  assert.deepEqual(events, []);
  assert.equal(launches, 0);
});

test("an occupied flat destination in the checkout list blocks git creation", async () => {
  const { userHome, repo, config } = await fixture();
  const destination = join(userHome, ".herdr", "worktrees", "Reaparr-collision");
  const events = [];
  let launches = 0;
  const result = await createWorktree({
    branch: "collision",
    repo,
    config,
    machine: null,
    existingDestinations: [destination],
    pathExists: async () => false,
    git: gitStub(events, destination),
    readHooks: () => plan([]),
    runSpace: () => { launches += 1; },
  });
  assert.equal(result, `Worktree destination already exists: ${destination}`);
  assert.deepEqual(events, []);
  assert.equal(launches, 0);
});

test("a filesystem collision blocks git creation after the flat destination is resolved", async () => {
  const { userHome, repo, config } = await fixture();
  const destination = join(userHome, ".herdr", "worktrees", "Reaparr-filesystem-collision");
  const events = [];
  let launches = 0;
  const result = await createWorktree({
    branch: "filesystem/collision",
    repo,
    config,
    machine: null,
    existingDestinations: [],
    pathExists: async (path) => {
      assert.equal(path, destination);
      return true;
    },
    git: gitStub(events, destination),
    readHooks: () => plan([]),
    runSpace: () => { launches += 1; },
  });
  assert.equal(result, `Worktree destination already exists: ${destination}`);
  assert.deepEqual(events, []);
  assert.equal(launches, 0);
});

test("a failed hook never starts the requested program, skips later hooks, and supports a manual setup retry", async () => {
  const { userHome, repo, config } = await fixture();
  const checkoutPath = join(userHome, ".herdr", "worktrees", "Reaparr-failure");
  const hooks = [
    { name: "failing first attempt", argv: ["sh", "-c", "if [ ! -f first-attempt ]; then touch first-attempt; exit 7; fi; printf setup-ok > setup-ok.txt"], timeout_seconds: 10 },
    { name: "must not run after failure", argv: ["sh", "-c", "printf second > second.txt"], timeout_seconds: 10 },
  ];
  const requestedArgv = ["sh", "-c", "printf started > requested.txt"];
  let launch;
  const result = await createWorktree({
    branch: "failure",
    repo,
    config,
    userHome,
    machine: null,
    pathExists: async () => false,
    requestedArgv,
    git: gitStub([], checkoutPath),
    readHooks: () => plan(hooks),
    runSpace: (args) => { launch = args; },
  });
  assert.equal(result, "");
  const gate = await runGate(launch.argv, launch.folder);
  assert.equal(gate.code, 0);
  assert.equal(await exists(join(checkoutPath, "requested.txt")), false);
  assert.equal(await exists(join(checkoutPath, "second.txt")), false);
  assert.match(gate.stdout, /exit code 7/);
  assert.match(gate.stdout, /Retry setup in this terminal:\nsh -c "\$HERDR_WORKTREE_GATE"/);
  assert.match(gate.stdout, /checkout was kept/);
  const retry = await runGate(["sh", "-c", hookGateRetryScript(hooks, requestedArgv), "herdr-worktree-hook-retry"], checkoutPath);
  assert.equal(retry.code, 0);
  assert.equal(await readFile(join(checkoutPath, "setup-ok.txt"), "utf8"), "setup-ok");
  assert.equal(await readFile(join(checkoutPath, "requested.txt"), "utf8"), "started");
  assert.equal(await exists(join(checkoutPath, "second.txt")), true);
});


test("hook and requested argv preserve spaces, quotes, dollar signs, globs, and separators literally", async () => {
  const { userHome, repo, config } = await fixture();
  const checkoutPath = join(userHome, ".herdr", "worktrees", "Reaparr-literal");
  const literal = "spaces 'quotes' $HOME; *";
  let launch;
  const result = await createWorktree({
    branch: "literal",
    repo,
    config,
    userHome,
    machine: null,
    requestedArgv: ["sh", "-c", "printf '%s' \"$1\" > requested.txt", "sh", literal],
    pathExists: async () => false,
    git: gitStub([], checkoutPath),
    readHooks: () => plan([{ name: "literal hook", argv: ["sh", "-c", "printf '%s' \"$1\" > hook.txt", "sh", literal], timeout_seconds: 10 }]),
    runSpace: (args) => { launch = args; },
  });
  assert.equal(result, "");
  const gate = await runGate(launch.argv, launch.folder);
  assert.equal(gate.code, 0);
  assert.equal(await readFile(join(checkoutPath, "hook.txt"), "utf8"), literal);
  assert.equal(await readFile(join(checkoutPath, "requested.txt"), "utf8"), literal);
});

test("a hook timeout is enforced inside the visible terminal and blocks the requested program", async () => {
  const { userHome, repo, config } = await fixture();
  const checkoutPath = join(userHome, ".herdr", "worktrees", "Reaparr-timeout");
  let launch;
  const result = await createWorktree({
    branch: "timeout",
    repo,
    config,
    userHome,
    machine: null,
    pathExists: async () => false,
    requestedArgv: ["sh", "-c", "printf started > requested.txt"],
    git: gitStub([], checkoutPath),
    readHooks: () => plan([{ name: "slow hook", argv: ["sh", "-c", "sleep 3"], timeout_seconds: 1 }]),
    runSpace: (args) => { launch = args; },
  });
  assert.equal(result, "");
  const gate = await runGate(launch.argv, launch.folder);
  assert.equal(gate.code, 0);
  assert.match(gate.stdout, /timed out/);
  assert.equal(await exists(join(checkoutPath, "requested.txt")), false);
});

test("Git registers a new checkout directly under the configured machine root", async () => {
  const { userHome, repo, config } = await fixture();
  config.machines.local.worktreeDirectory = join(userHome, "WORKTREES");
  await mkdir(repo.main);
  await mkdir(config.machines.local.worktreeDirectory);
  const git = async (cwd, args) => {
    const result = await runGate(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], cwd);
    return { ok: result.code === 0, out: result.stdout, err: result.stderr };
  };
  for (const args of [["init"], ["commit", "--allow-empty", "-m", "Initial"]]) {
    const result = await git(repo.main, args);
    assert.ok(result.ok, result.err);
  }
  let opening;
  const result = await createWorktree({ branch: "fixes", repo, config, machine: null,
    pathExists: exists, git, readHooks: () => plan([]), runSpace: args => { opening = args; } });
  assert.equal(result, "");
  const expected = join(userHome, "WORKTREES", "Reaparr-fixes");
  assert.equal(opening.folder, expected);
  const registered = await git(repo.main, ["worktree", "list", "--porcelain"]);
  assert.ok(registered.ok, registered.err);
  assert.ok(registered.out.split("\n").includes(`worktree ${expected}`));
  assert.equal(await exists(join(userHome, ".herdr", "worktrees")), false);
});

test("a local rule is not applied to a remote machine and the requested program still runs", async () => {
  const { userHome, repo, config } = await fixture();
  const checkoutPath = join(userHome, "remote-worktrees", "Reaparr-remote");
  const hooksConfig = JSON.stringify({ version: 2, projects: [{ machine: null, repo: repo.main, hooks: { on_created: [{ name: "local", argv: ["sh", "-c", "printf hook > hook.txt"], timeout_seconds: 1 }] } }] });
  const requestedArgv = ["sh", "-c", "printf remote > requested.txt"];
  let launch;
  const result = await createWorktree({
    branch: "remote",
    repo,
    config,
    userHome,
    machine: "unraid-dev",
    pathExists: async () => false,
    requestedArgv,
    git: gitStub([], checkoutPath),
    readHooks: ({ machine, main }) => hookPlan(hooksConfig, machine, main),
    runSpace: (args) => { launch = args; },
  });
  assert.deepEqual(launch.argv, requestedArgv);
  const gate = await runGate(launch.argv, launch.folder);
  assert.equal(gate.code, 0);
  assert.equal(await readFile(join(checkoutPath, "requested.txt"), "utf8"), "remote");
  assert.equal(await exists(join(checkoutPath, "hook.txt")), false);
});
