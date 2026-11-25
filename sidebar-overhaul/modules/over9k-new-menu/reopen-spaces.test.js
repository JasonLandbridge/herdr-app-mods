import assert from "node:assert/strict";
import { test } from "node:test";
import { reopenCandidates } from "./reopen-spaces.js";

test("reopen list merges recent parked and workspace entries without open-space duplicates", () => {
  const entries = reopenCandidates({
    recent: [{ folder: "/projects/a/", name: "Saved name" }, { folder: "/projects/open" }, { folder: "/remote", machine: "remote" }],
    parked: ["/projects/a", "/projects/b"], scanned: [{ dir: "/projects/c" }, { dir: "/projects/a" }],
    open: [{ folder: "/projects/open" }],
  });
  assert.deepEqual(entries, [
    { folder: "/projects/a", name: "Saved name", sources: ["Recent", "Parked", "Workspace"] },
    { folder: "/projects/b", name: "b", sources: ["Parked"] },
    { folder: "/projects/c", name: "c", sources: ["Workspace"] },
  ]);
});

test("machine-qualified recent and open records stay on their machine", () => {
  assert.deepEqual(reopenCandidates({ machine: "remote", recent: [
    { folder: "/projects/a", machine: "other" }, { folder: "/projects/b", machine: "remote" },
  ], open: [{ folder: "/projects/b", machine: null }] }).map(x => x.folder), ["/projects/b"]);
});
