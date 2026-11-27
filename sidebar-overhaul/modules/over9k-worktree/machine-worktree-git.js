import { flatDestination, machineKey } from "../../config.js";
import { hookGateArgv, resolveHookPlan } from "./worktree-hooks.js";
import { hookPreflight } from "../over9k-worktree-settings/settings.js";

/** @typedef {typeof import("herdr").exec} Exec */
/** @typedef {{ name: string, defaultBranch: string, private: boolean }} Repository */

/** Resolve hooks without creating a worktree, for explicit user review. */
export async function previewMachineWorktree({ exec, machine, root, repo, branch, hooksText, source }) {
  const path = flatDestination(root, repo.name, branch);
  const store = `${root.replace(/[\\/]+$/, "")}/.herdr-repositories/${repo.name}.git`;
  const hooks = await resolveHookPlan(hooksText, machine, store, async cwd => {
    const result = await exec("git", ["config", "--local", "--get", "remote.origin.url"], { cwd, on: machine ?? undefined }).catch(() => null);
    return result?.code === 0 ? result.stdout : null;
  }, github(repo.name));
  if ("error" in hooks) return { path, error: hooks.error };
  const error = await hookPreflight(hooks.hooks, machine, exec);
  if (error) return { path, error };
  return { path, source: source ?? branch, hooks: hooks.hooks, ruleRepo: hooks.ruleRepo };
}

/** @param {string} path */
const github = (path) => `https://github.com/${path}.git`;
/** @param {string} name */
const validRepo = (name) => typeof name === "string" && /^[\w-]+\/[\w.-]+$/.test(name) && !/\/(?:\.|\.\.)$/.test(name);

/** @param {Exec} exec @param {string} command @param {string[]} args @param {Parameters<Exec>[2]} options @param {string} message */
async function checked(exec, command, args, options, message) {
  const result = await exec(command, args, options);
  if (result.code !== 0) throw new Error(`${message}${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout?.trim() ?? "";
}

/** @param {Exec} exec @returns {Promise<Repository[]>} */
export async function githubRepositories(exec) {
  const rows = await checked(exec, "gh", ["api", "--hostname", "github.com", "--paginate",
    "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100",
    "--jq", '.[] | [.full_name,.default_branch,(.private|tostring)] | @tsv'], {},
  "Could not list GitHub repositories. Check `gh auth status` on this computer");
  return rows.split("\n").map(line => {
    const [name, defaultBranch, visibility] = line.split("\t");
    return { name, defaultBranch, private: visibility === "true" };
  }).filter(repo => validRepo(repo.name));
}

/** @param {Exec} exec @param {Repository} repo */
export async function githubBranches(exec, repo) {
  if (!validRepo(repo.name)) throw new Error("Invalid GitHub repository name.");
  const rows = await checked(exec, "gh", ["api", "--hostname", "github.com", "--paginate",
    `repos/${repo.name}/branches?per_page=100`, "--jq", ".[].name"], {}, "Could not list branches");
  return rows.split("\n").filter(Boolean).sort((a, b) => Number(b === repo.defaultBranch) - Number(a === repo.defaultBranch) || a.localeCompare(b));
}

/** @param {{machines: Record<string, {worktreeDirectory: string}>}} config @param {string | null} machine */
export function machineWorktreeRoot(config, machine) {
  const root = config.machines?.[machineKey(machine)]?.worktreeDirectory;
  if (!root) throw new Error(`Set a worktree folder in Machine settings for ${machine ?? "this computer"}.`);
  return root;
}

/** @param {{exec: Exec, machine: string | null, root: string, repo: Repository, branch: string, hooksText: string | null, source?: string, cachedCommit?: string, reviewedHooks?: unknown[], reviewedRuleRepo?: string}} options */
export async function checkoutMachineWorktree({ exec, machine, root, repo, branch, hooksText, source, cachedCommit, reviewedHooks, reviewedRuleRepo }) {
  if (!validRepo(repo.name)) throw new Error("Invalid GitHub repository name.");
  const path = flatDestination(root, repo.name, branch);
  const base = root.replace(/[\\/]+$/, "");
  // Keep reusable Git objects out of the working directories, namespaced by owner.
  const store = `${base}/.herdr-repositories/${repo.name}.git`;
  const url = github(repo.name);
  const on = machine ?? undefined;
  const at = { on };
  /** @param {string} cwd @param {string[]} args @param {string} message @param {number} [timeout] */
  const git = (cwd, args, message, timeout) => checked(exec, "git", args, { on, cwd, timeout }, message);
  /** @param {string} path */
  const exists = async (path) => (await exec("test", ["-e", path], at)).code === 0 || (await exec("test", ["-L", path], at)).code === 0;
  await checked(exec, "sh", ["-c", 'test -d "$1" && test -w "$1" && test -x "$1"', "sh", root], at,
    `The worktree folder must exist and be writable on ${machine ?? "this computer"}: ${root}`);
  await git(root, ["check-ref-format", `refs/heads/${branch}`], "Invalid branch name");
  if (source) await git(root, ["check-ref-format", `refs/heads/${source}`], "Invalid source branch");
  const credentials = ["-c", "credential.https://github.com.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential", "-c", "credential.interactive=false"];
  const fresh = !await exists(store);
  if (!fresh) {
    const bare = await git(store, ["rev-parse", "--is-bare-repository"], "Could not inspect the repository store");
    const origin = await git(store, ["config", "--get", "remote.origin.url"], "Could not read the repository store’s origin");
    if (bare !== "true" || origin !== url) throw new Error(`Repository store does not match ${repo.name}: ${store}`);
    const listed = await git(store, ["worktree", "list", "--porcelain", "-z"], "Could not list existing worktrees");
    for (const block of listed.split("\0\0")) {
      const fields = block.split("\0");
      if (fields[0]?.startsWith("worktree ") && fields.includes(`branch refs/heads/${branch}`) && !fields.includes("bare") && !fields.some(field => field.startsWith("prunable"))) {
        const folder = fields[0].slice(9);
        if ((await exec("test", ["-d", folder], at)).code === 0) return { existingFolder: folder };
      }
    }
  }
  if (await exists(path)) throw new Error(`Worktree destination already exists: ${path}`);
  if (source === branch) throw new Error(`Branch already exists: ${branch}`);
  const hooks = await resolveHookPlan(hooksText, machine, store, async cwd => {
    const result = await exec("git", ["config", "--local", "--get", "remote.origin.url"], { cwd, on }).catch(() => null);
    return result?.code === 0 ? result.stdout : null;
  }, url);
  if ("error" in hooks) throw new Error(hooks.error);

  if (reviewedHooks && (JSON.stringify(reviewedHooks) !== JSON.stringify(hooks.hooks) || reviewedRuleRepo !== hooks.ruleRepo))
    throw new Error("Worktree hooks changed since review. Review them again before creating the worktree.");
  const preflightError = await hookPreflight(hooks.hooks, machine, exec);
  if (preflightError) throw new Error(preflightError);

  const baseBranch = source ?? branch;
  if (fresh) {
    await checked(exec, "gh", ["repo", "clone", "--no-upstream", url, store,
      "--", "--bare", "--no-tags", "--single-branch", `--branch=${baseBranch}`], { on, cwd: root, timeout: 600_000 },
    `Could not clone ${repo.name} on ${machine ?? "this computer"}. Check GitHub CLI authentication on that machine`);
  }

  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  await git(store, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], "Could not configure branch tracking");
  const targetRef = `refs/heads/${branch}`;
  const local = await exec("git", ["show-ref", "--verify", "--quiet", targetRef], { cwd: store, on });
  if (source && (local.code === 0 ||
    (await exec("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: store, on })).code === 0)) {
    throw new Error(`Branch already exists: ${branch}`);
  }
  let start = remoteRef;
  if (fresh) {
    await git(store, ["update-ref", remoteRef, `refs/heads/${baseBranch}`], "Could not record the cloned branch");
    await git(store, ["branch", `--set-upstream-to=${remoteRef}`, "--", baseBranch], "Could not set the branch upstream");
  } else if (source && cachedCommit) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(cachedCommit)) throw new Error("Invalid cached commit.");
    start = cachedCommit;
  } else {
    try {
      await git(store, [...credentials, "fetch", "--no-tags", "origin", `+refs/heads/${baseBranch}:${remoteRef}`],
      `Could not fetch ${baseBranch} on ${machine ?? "this computer"}`, 600_000);
    } catch (error) {
      if (!source || !/could not resolve host|failed to connect|couldn.t connect|network is unreachable|connection (?:timed out|refused|reset)|operation timed out/i.test(String(error))) throw error;
      const result = await exec("git", ["rev-parse", "--verify", `${remoteRef}^{commit}`], { cwd: store, on });
      if (result.code !== 0) throw error;
      return { cachedCommit: result.stdout.trim() };
    }
  }
  if (source && !cachedCommit) {
    const remote = await git(store, [...credentials, "ls-remote", "--heads", "origin", targetRef], "Could not check the new branch name on GitHub");
    if (remote) throw new Error(`Branch already exists on GitHub: ${branch}`);
  }
  const add = source ? ["worktree", "add", "--no-track", "-b", branch, "--", path, start]
    : local.code === 0 ? ["worktree", "add", "--", path, branch]
    : ["worktree", "add", "--track", "-b", branch, "--", path, remoteRef];
  await git(store, add, "Could not create worktree", 600_000);
  const argv = hookGateArgv(hooks.hooks, ["bash", "-lc", "exec omp"], { repo: store, cwd: path, ...(hooks.ruleRepo ? { ruleRepo: hooks.ruleRepo } : {}) });
  return { folder: path, machine: machine ?? "", tab: branch, argv };
}
