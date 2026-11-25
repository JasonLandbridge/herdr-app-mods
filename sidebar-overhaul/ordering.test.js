import assert from "node:assert/strict";
import { test } from "node:test";
import { orderBlocks } from "./ordering.js";

const row = (id, { machine = null, pinned = false, under } = {}) => ({
  w: { id, machine, folder: `/work/${id}` },
  pinned,
  ...(under === undefined ? {} : { under, tree: "└─" }),
});
const rank = (r) => r.tree || r.pinned ? 2 : 1;
const names = (rows) => rows.map((r) => `${r.w.machine ?? "local"}:${r.w.id}`);

test("an unpinned worktree stays below Reaparr rather than drifting below OMP Config", () => {
  const parent = row("reaparr");
  const child = row("reaparr-worktree", { under: parent.w.id });
  const sibling = row("omp-config");

  assert.deepEqual(names(orderBlocks([parent, child, sibling], rank)), [
    "local:reaparr",
    "local:reaparr-worktree",
    "local:omp-config",
  ]);
  assert.equal(child.under, parent.w.id);
  assert.equal(child.tree, "└─");
});

test("the parent rank wins for both parent and child pin combinations", () => {
  const unpinnedParent = row("plain-parent");
  const pinnedChild = row("plain-child", { pinned: true, under: unpinnedParent.w.id });
  const pinnedParent = row("pinned-parent", { pinned: true });
  const unpinnedChild = row("pinned-child", { under: pinnedParent.w.id });
  const unpinnedSibling = row("plain-sibling");
  const pinnedSibling = row("pinned-sibling", { pinned: true });

  assert.deepEqual(names(orderBlocks([
    unpinnedParent, pinnedSibling, pinnedChild,
  ], rank)), ["local:plain-parent", "local:plain-child", "local:pinned-sibling"]);
  assert.deepEqual(names(orderBlocks([
    pinnedParent, unpinnedSibling, unpinnedChild,
  ], rank)), ["local:plain-sibling", "local:pinned-parent", "local:pinned-child"]);
});

test("multiple worktrees stay in their original sibling order inside one block", () => {
  const parent = row("repo");
  const first = row("repo-first", { pinned: true, under: parent.w.id });
  const second = row("repo-second", { under: parent.w.id });
  const third = row("repo-third", { pinned: true, under: parent.w.id });
  const sibling = row("other", { pinned: true });

  assert.deepEqual(names(orderBlocks([parent, first, second, third, sibling], rank)), [
    "local:repo",
    "local:repo-first",
    "local:repo-second",
    "local:repo-third",
    "local:other",
  ]);
});

test("same space ids on different machines keep their own worktree blocks", () => {
  const localParent = row("repo");
  const localChild = row("local-worktree", { under: localParent.w.id, pinned: true });
  const remoteParent = row("repo", { machine: "builder" });
  const remoteChild = row("remote-worktree", { machine: "builder", under: remoteParent.w.id, pinned: true });
  const pinned = row("other", { pinned: true });
  const machineRank = (r) => r.w.machine ? 0 : rank(r);

  assert.deepEqual(names(orderBlocks([
    localParent, localChild, remoteParent, remoteChild, pinned,
  ], machineRank)), [
    "builder:repo",
    "builder:remote-worktree",
    "local:repo",
    "local:local-worktree",
    "local:other",
  ]);
});
