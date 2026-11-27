import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKTREE_LABELS,
  availabilityChecks,
  commandFieldKey,
  commandFieldParts,
  parseArgvText,
  parseConfig,
  retryGuard,
  saveConfig,
  selectSetupResult,
  updateCommandField,
  validateConfig,
  githubRuleIdentity,
} from "./settings.js";

const hooks = [{ name: "Initialize", argv: ["bash", "/home/me/init.sh"], timeout_seconds: 1800 }];
const config = { version: 2, projects: [{ machine: null, repo: "/work/Reaparr", hooks: { on_created: hooks } }] };
const labels = (repo, cwd, status, exitreason = "") => ({
  [WORKTREE_LABELS.repo]: repo,
  [WORKTREE_LABELS.cwd]: cwd,
  [WORKTREE_LABELS.status]: status,
  [WORKTREE_LABELS.exitreason]: exitreason,
});

test("invalidconfig rejects malformed JSON, relative roots, bad argv and non-positive timeouts", () => {
  const malformed = parseConfig("{", [null]);
  assert.deepEqual(malformed.config, null);
  assert.match(malformed.errors.join(" "), /valid JSON/);

  const invalid = parseConfig(JSON.stringify({
    version: 2,
    projects: [{ machine: null, repo: "relative", hooks: { on_created: [{ name: "", argv: [""], timeout_seconds: 0 }] } }],
  }), [null]);
  assert.equal(invalid.config, null);
  assert.match(invalid.errors.join(" "), /repo must be an absolute path or GitHub owner\/repo/);
  assert.match(invalid.errors.join(" "), /name must be a non-empty string/);
  assert.match(invalid.errors.join(" "), /argv must start with a non-empty executable/);
  assert.match(invalid.errors.join(" "), /timeout_seconds must be a positive integer/);
  const invalidRuleIdentity = parseConfig(JSON.stringify({
    version: 2,
    projects: [
      { machine: "unknown", repo: "/work/Other", hooks: { on_created: [] } },
      { machine: null, repo: "/work/Reaparr", hooks: { on_created: [] } },
      { machine: null, repo: "/work/Reaparr/../Reaparr", hooks: { on_created: [] } },
    ],
  }), [{ name: null }]);
  assert.equal(invalidRuleIdentity.config, null);
  assert.match(invalidRuleIdentity.errors.join(" "), /not a known machine/);
  assert.match(invalidRuleIdentity.errors.join(" "), /duplicates another project/);

  assert.deepEqual(parseArgvText("[\"bash\",\"script.sh\"]"), ["bash", "script.sh"]);
  assert.throws(() => parseArgvText("bash script.sh"), /JSON array/);
});

test("GitHub owner/repo rules are validated and duplicates are machine scoped", () => {
  assert.equal(githubRuleIdentity("github:Acme/Widget.git"), "acme/widget");
  assert.equal(githubRuleIdentity("Acme/Widget"), "");
  assert.equal(githubRuleIdentity("github:Acme/../Widget"), "");
  const rules = { version: 2, projects: [
    { machine: "remote", repo: "github:Acme/Widget", hooks: { on_created: [] } },
    { machine: "remote", repo: "github:acme/widget", hooks: { on_created: [] } },
    { machine: null, repo: "github:acme/widget", hooks: { on_created: [] } },
  ] };
  assert.match(validateConfig(rules, [{ name: "remote" }, { name: null }]).join(" "), /duplicates another project for the same machine and GitHub repository/);
});
test("editor command fields update the command draft slots used by save", () => {
  const draft = [{ name: "old", argv: "[]", timeout: "1" }];
  const values = { name: "renamed", argv: "[\"bash\",\"/setup.sh\"]", timeout: "42" };
  for (const field of Object.keys(values)) {
    const key = commandFieldKey(0, field);
    assert.deepEqual(commandFieldParts(key), { index: 0, field });
    assert.equal(updateCommandField(draft, key, values[field]), true);
  }
  assert.deepEqual(draft[0], values);
  assert.equal(updateCommandField(draft, "cmd-name-9", "ignored"), false);
});

test("saveconflict never overwrites a changed snapshot and reports a reloadable error", async () => {
  let writes = 0;
  const result = await saveConfig({
    path: "/config/worktree-hooks.json",
    config,
    expected: "old",
    readTextFile: async () => "new",
    writeTextFile: async () => { writes += 1; throw new Error("stale snapshot"); },
  });
  assert.equal(writes, 1);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.match(result.error, /changed on disk/);
});

test("resultselection chooses the newest exact repo/cwd setup terminal and ignores unrelated terminals", () => {
  const exactFailed = { address: "t-old", state: "live", pid: 4, foreground: { pid: 4, argv: ["bash"] }, labels: labels("/work/Reaparr", "/tmp/wt", "failed", "hook_exit_7"), created_ms: 10 };
  const unrelated = { address: "t-other", state: "live", labels: labels("/work/Other", "/tmp/wt", "running"), created_ms: 99 };
  const exactRunning = { address: "t-new", state: "live", pid: 7, foreground: { pid: 7, argv: ["sh"] }, labels: labels("/work/Reaparr", "/tmp/wt", "running"), created_ms: 20 };
  const exactSucceeded = { address: "t-success", state: "live", labels: labels("/work/Reaparr", "/tmp/wt", "succeeded", "success"), created_ms: 30 };
  assert.equal(selectSetupResult([exactFailed, unrelated, exactRunning], { repo: "/work/Reaparr", cwd: "/tmp/wt" }), exactRunning);
  assert.equal(selectSetupResult([exactFailed, exactSucceeded], { repo: "/work/Reaparr", cwd: "/tmp/wt" }), exactSucceeded);
});

test("setup result can be selected by explicit rule identity", () => {
  const explicit = { address: "t-explicit", labels: { ...labels("/work/Reaparr", "/tmp/wt", "succeeded"), [WORKTREE_LABELS.ruleRepo]: "github:acme/reaparr" } };
  const pathRule = { address: "t-path", labels: labels("/work/Reaparr", "/tmp/wt", "failed") };
  assert.equal(selectSetupResult([pathRule, explicit], { repo: "/work/Reaparr", ruleRepo: "github:acme/reaparr", cwd: "/tmp/wt" }), explicit);
  assert.equal(selectSetupResult([pathRule, explicit], { repo: "/work/Reaparr", ruleRepo: "/work/Reaparr", cwd: "/tmp/wt" }), pathRule);
});

test("retryguard allows only the failed matching terminal while its own shell is idle", () => {
  const expected = { repo: "/work/Reaparr", cwd: "/tmp/wt" };
  const safe = { address: "t1", state: "live", pid: 4, foreground: { pid: 4, argv: ["bash"] }, labels: labels(expected.repo, expected.cwd, "failed", "hook_exit_7") };
  assert.equal(retryGuard(safe, expected).ok, true);

  const busyEditor = { ...safe, foreground: { pid: 8, argv: ["nvim", "README.md"] } };
  assert.equal(retryGuard(busyEditor, expected).ok, false);
  const wrongStatus = { ...safe, labels: labels(expected.repo, expected.cwd, "succeeded", "success") };
  assert.equal(retryGuard(wrongStatus, expected).ok, false);
  const dead = { ...safe, state: "exited" };
  assert.equal(retryGuard(dead, expected).ok, false);
});

test("availability checks inspect roots, executables and explicit script operands without running setup", async () => {
  const calls = [];
  const outcomes = new Map([["/work/Reaparr", 0], ["bash", 0], ["/home/me/init.sh", 1]]);
  const result = await availabilityChecks(config.projects[0], async (command, args, options) => {
    calls.push({ command, target: args[args.length - 1], options });
    return { code: outcomes.get(args[args.length - 1]) ?? 99, stdout: "", stderr: "" };
  });
  assert.equal(result.ok, false);
  assert.equal(result.checked_only, true);
  assert.equal(result.root.ok, true);
  assert.equal(result.commands[0].executable.ok, true);
  assert.equal(result.commands[0].script.ok, false);
  assert.deepEqual(calls, [
    { command: "sh", target: "/work/Reaparr", options: { on: null } },
    { command: "sh", target: "bash", options: { on: null } },
    { command: "sh", target: "/home/me/init.sh", options: { on: null } },
  ]);
});

test("a GitHub rule checks its script on the target without treating the repository as a directory", async () => {
  const targets = [];
  const result = await availabilityChecks({ ...config.projects[0], machine: "builder", repo: "github:owner/project" }, async (_, args, { on }) => {
    assert.equal(on, "builder");
    targets.push(args.at(-1));
    return { code: args.at(-1) === "bash" ? 0 : 1 };
  });
  assert.deepEqual(targets, ["bash", "/home/me/init.sh"]);
  assert.equal(result.ok, false);
  assert.equal(result.commands[0].script.ok, false);
});
