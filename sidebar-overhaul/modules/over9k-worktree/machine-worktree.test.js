import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";
import { createNativeTestHost, textOf, trigger } from "../over9k/native-test-host.js";

const host = createNativeTestHost();
const tasks = [];
const closed = [];
const cx = { ...host.context(), focus_handle: () => ({ focus() {} }), spawn: fn => tasks.push(fn(cx)), timer: { after() {} } };
let config;
let hooksText = null;
let execute;
mock.module("gpui-kit", () => host.gpuiKit);
mock.module("gpui-base", () => ({
  ...host.gpuiBase,
  InputState: { new: ({ placeholder, value: initial = "" }) => {
    const handlers = new Map();
    let value = initial;
    return { placeholder, on: (name, fn) => handlers.set(name, fn), focus() {}, release() {}, value: () => value,
      set_value: next => { value = next; handlers.get("change")?.({}, cx); },
      submit: () => handlers.get("submit")({}, cx) };
  } },
  Input: { new: state => host.gpuiBase.h_flex().child(state.value() || state.placeholder) },
  Scrollbar: { vertical: () => host.gpuiBase.h_flex() },
  VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
  v_virtual_list: (id, count, _size, _key, render) => host.gpuiBase.v_flex().id(id).children(render({ start: 0, end: count })),
}));
let savedRecent = "{}";
let rejectFirstLaunch = true;
mock.module("herdr", () => ({
  ...host.herdr,
  props: () => ({}),
  closeOverlay: id => closed.push(id),
  readTextFile: async path => path.endsWith("sidebar.config.json") ? JSON.stringify(config) : path.endsWith("worktree-recent.json") ? savedRecent : hooksText,
  writeTextFile: async (_path, text) => { savedRecent = text; },
  exec: (...args) => {
    if (args[0] === "herdr-app") {
      host.calls.run.push({ name: "space.new", args: JSON.parse(args[1][2]) });
      const stdout = rejectFirstLaunch ? '{"error":"Machine disconnected"}' : "{}";
      rejectFirstLaunch = false;
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    }
    return execute(...args);
  },
}));
const { default: Picker } = await import("./machine-worktree.js");
const { checkoutMachineWorktree } = await import("./machine-worktree-git.js");

function sh(command, args, cwd) {
  const result = Bun.spawnSync([command, ...args], { cwd });
  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
}
function git(cwd, ...args) {
  const result = sh("git", args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

const origin = "https://github.com/owner/project.git";
const repo = { name: "owner/project", defaultBranch: "main", private: true };

test("filtering a repository and branch previews and creates a tracked worktree on the clicked machine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machine-worktree-test-"));
  try {
    const source = join(dir, "source");
    const root = join(dir, "remote-workspaces");
    await mkdir(root);
    git(dir, "init", "-b", "main", source);
    git(source, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    git(source, "switch", "-c", "feature/ui");
    git(source, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--allow-empty", "-m", "Feature commit");
    git(source, "switch", "main");
    git(source, "branch", "fix/next", "main");
    git(source, "remote", "add", "origin", "git@github.com:OWNER/project.git");
    hooksText = JSON.stringify({ version: 2, projects: [
      { machine: null, repo: source, hooks: { on_created: [{ name: "Wrong machine", argv: ["sh", "-c", "exit 99"], timeout_seconds: 5 }] } },
      { machine: "remote", repo: "github:owner/project", hooks: { on_created: [{ name: "Initialize checkout", argv: ["sh", "-c", 'pwd > hook-ran.txt'], timeout_seconds: 5 }] } },
    ] });
    host.reset();
    closed.length = 0;
    config = { version: 1, machines: {
      local: { worktreeDirectory: source, locations: {}, projects: {} },
      remote: { worktreeDirectory: root, locations: {}, projects: {} },
    }, repositories: {}, options: {} };
    let clones = 0;
    let offline = false;
    execute = async (command, args, options = {}) => {
      if (command === "gh" && args[0] === "api") {
        assert.equal(options.on, undefined, "GitHub discovery uses the UI host credentials");
        const listing = args.find(arg => arg.startsWith("repos/"));
        if (listing) assert.equal(listing, "repos/owner/project/branches?per_page=100");
        return { code: 0, stdout: listing ? "feature/ui\nmain\nfix/next" : "owner/other\tmain\tfalse\nowner/project\tmain\ttrue", stderr: "" };
      }
      assert.equal(options.on, "remote", `${command} must execute on the clicked machine`);
      if (command === "gh") {
        clones++;
        const at = args.indexOf("--");
        assert.equal(args[at - 2], origin);
        const store = args[at - 1];
        git(root, "clone", ...args.slice(at + 1), source, store);
        git(store, "remote", "set-url", "origin", origin);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (offline && args.includes("fetch")) return { code: 128, stdout: "", stderr: "Could not resolve host: github.com" };
      if (command === "git") return sh(command, ["-c", `url.${source}.insteadOf=${origin}`, ...args], options.cwd);
      return sh(command, args, options.cwd);
    };
    const view = new Picker();
    view.init({ view: "machine-worktree", machine: "remote", overlay: "picker" }, cx);
    await Promise.all(tasks.splice(0));
    view.input.set_value("owner project");
    const repositories = textOf(view.render());
    assert.match(repositories, /owner\/project/);
    assert.doesNotMatch(repositories, /owner\/other/);
    view.input.submit();
    await Promise.all(tasks.splice(0));
    assert.deepEqual(host.calls.run, [], "looking at branches does not launch anything");
    view.input.set_value("feature ui");
    const path = join(root, "project-feature-ui");
    const branchPicker = view.render();
    assert.ok(textOf(branchPicker).includes(path));
    assert.doesNotMatch(textOf(branchPicker), /fix\/next/);
    trigger(branchPicker, "machine-worktree-submit", "click", {}, cx);
    await Promise.all(tasks.splice(0));
    assert.equal(host.calls.run.length, 0, "reviewing hooks does not create or launch a worktree");
    assert.match(textOf(view.render()), /Initialize checkout/);
    trigger(view.render(), "machine-worktree-submit", "click", {}, cx);
    await Promise.all(tasks.splice(0));
    assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), "feature/ui");
    assert.deepEqual(JSON.parse(savedRecent).remote, [{ repo: "owner/project", branch: "feature/ui" }]);
    assert.equal(git(path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/ui");
    assert.match(textOf(view.render()), /Checkout created .*Machine disconnected/);
    const [firstLaunch] = host.calls.run;
    trigger(view.render(), "machine-worktree-reopen", "click", {}, cx);
    await Promise.all(tasks.splice(0));
    assert.deepEqual(host.calls.run, [firstLaunch, firstLaunch]);
    const [{ name, args: { argv, ...launch } }] = host.calls.run;
    assert.equal(name, "space.new");
    assert.deepEqual(launch, { folder: path, machine: "remote", tab: "feature/ui" });
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "omp"), '#!/bin/sh\nset -eu\ntest "$(cat hook-ran.txt)" = "$PWD"\nprintf launched > omp-ran.txt\n', { mode: 0o755 });
    // A login shell may replace PATH; start the gate with the same executable argv,
    // but inject the fixture executable via Bash's startup environment.
    const startup = join(dir, "bash-env");
    await writeFile(startup, `export PATH='${bin}':"$PATH"\n`);
    const result = Bun.spawnSync(argv, { cwd: path, env: { ...process.env, HC_TERMINAL_ID: "", BASH_ENV: startup, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.equal(await readFile(join(path, "omp-ran.txt"), "utf8"), "launched");
    assert.deepEqual(closed, ["picker"]);

    const next = await checkoutMachineWorktree({ exec: execute, machine: "remote", root, repo, branch: "fix/next", hooksText: null });
    assert.equal(git(next.folder, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/fix/next");
    assert.equal(clones, 1, "reuses the same Git object store for another branch");
    assert.deepEqual(await checkoutMachineWorktree({ exec: execute, machine: "remote", root, repo, branch: "feature/ui", hooksText: null }), { existingFolder: path });

    view.input.set_value("feature ui");
    view.input.submit();
    await Promise.all(tasks.splice(0));
    view.input.submit();
    await Promise.all(tasks.splice(0));
    trigger(view.render(), "machine-worktree-run-setup", "click", {}, cx);
    assert.deepEqual(host.calls.openOverlay.at(-1), { mod: "sidebar-overhaul", kind: "dialog", width: 560, height: 420, props: { view: "worktree", action: "setup", folder: path, machine: "remote" } });

    const picker = new Picker();
    picker.init({ view: "machine-worktree", machine: "remote", overlay: "new-branch" }, cx);
    await Promise.all(tasks.splice(0));
    picker.input.set_value("owner project");
    picker.input.submit();
    await Promise.all(tasks.splice(0));
    picker.input.set_value("fresh/topic");
    const beforeCreate = host.calls.run.length;
    assert.match(textOf(picker.render()), /No matching branches/);
    picker.input.submit();
    await Promise.all(tasks.splice(0));
    assert.equal(host.calls.run.length, beforeCreate, "Enter does not implicitly create an unmatched branch");
    trigger(picker.render(), "machine-worktree-create", "click", {}, cx);
    assert.equal(picker.input.value(), "fresh/topic");
    picker.input.submit();
    await Promise.all(tasks.splice(0));
    picker.input.submit();
    await Promise.all(tasks.splice(0));
    const created = join(root, "project-fresh-topic");
    assert.equal(git(created, "symbolic-ref", "--short", "HEAD"), "fresh/topic");
    assert.equal(git(created, "rev-parse", "HEAD"), git(source, "rev-parse", "main"));
    await assert.rejects(checkoutMachineWorktree({ exec: execute, machine: "remote", root, repo, branch: "main", source: "feature/ui", hooksText: null }), /Branch already exists/);

    trigger(picker.render(), "machine-worktree-cancel-source", "click", {}, cx);
    picker.input.set_value("feature/ui");
    trigger(picker.render(), "machine-worktree-branch-from", "click", {}, cx);
    assert.match(textOf(picker.render()), /New branch name…/);
    assert.doesNotMatch(textOf(picker.render()), /Filter branches…/);
    picker.input.set_value("offline/topic");
    offline = true;
    const launches = host.calls.run.length;
    picker.input.submit();
    await Promise.all(tasks.splice(0));
    const review = textOf(picker.render());
    assert.match(review, /Source: owner\/project \/ feature\/ui/);
    assert.match(review, /New branch: offline\/topic/);
    assert.match(review, /Initialize checkout/);
    assert.equal(review.split("Destination:").length, 2);
    picker.input.submit();
    await Promise.all(tasks.splice(0));
    assert.match(textOf(picker.render()), /may be stale/);
    picker.input.submit();
    await Promise.all(tasks.splice(0));
    assert.equal(host.calls.run.length, launches);
    trigger(picker.render(), "machine-worktree-use-cache", "click", {}, cx);
    await Promise.all(tasks.splice(0));
    const cached = join(root, "project-offline-topic");
    assert.equal(git(cached, "symbolic-ref", "--short", "HEAD"), "offline/topic");
    assert.equal(git(cached, "rev-parse", "HEAD"), git(source, "rev-parse", "feature/ui"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
