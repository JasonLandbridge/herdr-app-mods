import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HIDDEN_LISTINGS,
  HIDDEN_REMOVALS,
  applyHiddenRemovals,
  groupListingKey,
  isGroupDismissed,
  isRecordDismissed,
  normalizeHiddenListings,
} from "./hidden-listings.js";

const live = (address, created_ms) => ({ address, created_ms, state: "live" });
const ended = (address, created_ms) => ({ address, created_ms, state: "done" });
const ready = (name = null) => ({ name, layout: "ready" });
const loading = (name = null) => ({ name, layout: "loading" });
const offline = (name) => ({ name, layout: "unavailable" });
const group = (key = "group-project", machine = null, folder = "/work/project") => ({
  key,
  kind: "project",
  machine,
  folder,
});
const removal = (id = "close-1", overrides = {}) => ({
  id,
  targets: [{ address: "t1", created_ms: 10 }],
  recordKeys: ["record-1"],
  group: group(),
  ...overrides,
});

const baseVisibility = {
  version: 1,
  open: true,
  hidden: {
    t1: { created_ms: 10, recordKey: "record-1" },
    t2: { created_ms: 20, recordKey: "record-2" },
    "remote/t3": { created_ms: 30, recordKey: "record-3" },
  },
  groups: {
    "group-project": { kind: "project", label: "Project", machine: null, folder: "/work/project" },
    "group-other": { kind: "project", label: "Other", machine: null, folder: "/work/other" },
  },
  effective: { t1: { explicit: true } },
  groupEffective: { t1: { group: "group-project", inheritedFrom: null } },
};

test("exports the durable shared-state keys", () => {
  assert.equal(HIDDEN_LISTINGS, "over9k.hiddenListings");
  assert.equal(HIDDEN_REMOVALS, "over9k.hiddenRemovals");
});

test("normalizes listing dismissals to the whitelisted boolean state", () => {
  const groupKey = groupListingKey(group(" group-1 "));
  const listings = normalizeHiddenListings({
    version: 99,
    records: { " record-1 ": true, ignored: false, object: { argv: ["secret"] } },
    groups: { [groupKey]: true, ignored: 1 },
    argv: ["never persist this"],
  });

  assert.deepEqual(listings, {
    version: 1,
    records: { "record-1": true },
    groups: { [groupListingKey(group("group-1"))]: true },
  });
  assert.equal(isRecordDismissed(listings, "record-1"), true);
  assert.equal(isRecordDismissed(listings, "ignored"), false);
  assert.equal(isGroupDismissed(listings, group("group-1")), true);
});

test("uses normalized folder and machine boundaries for group identities", () => {
  assert.equal(groupListingKey(group("local-project", null, "/work/project/")), JSON.stringify([null, "project", "/work/project"]));
  assert.notEqual(
    groupListingKey(group("remote-project", "builder", "/work/project")),
    groupListingKey(group("local-project", null, "/work/project")),
  );
  assert.equal(
    groupListingKey({ key: "remote:fallback", kind: "project", machine: "builder", folder: "" }),
    JSON.stringify(["builder", "project", "remote:fallback"]),
  );
});

test("retains a pending event while its exact live incarnation remains", () => {
  const result = applyHiddenRemovals({
    visibility: baseVisibility,
    listings: null,
    pending: [removal()],
    terminals: [live("t1", 10)],
    machines: [ready()],
  });

  assert.equal(result.pending.length, 1);
  assert.deepEqual(result.pending[0], removal());
  assert.deepEqual(result.listings, { version: 1, records: {}, groups: {} });
  assert.deepEqual(result.visibility.hidden.t1, { created_ms: 10, recordKey: "record-1" });
});

test("completes an ended event only after the authoritative machine layout is ready", () => {
  const result = applyHiddenRemovals({
    visibility: baseVisibility,
    listings: null,
    pending: [removal()],
    terminals: [],
    machines: [ready()],
  });

  assert.deepEqual(result.pending, []);
  assert.equal(result.listings.records["record-1"], true);
  assert.equal(result.listings.groups[groupListingKey(group())], true);
  assert.deepEqual(result.visibility.hidden, {
    t2: { created_ms: 20, recordKey: "record-2" },
    "remote/t3": { created_ms: 30, recordKey: "record-3" },
  });
  assert.deepEqual(result.visibility.groups, {
    "group-other": { kind: "project", label: "Other", machine: null, folder: "/work/other" },
  });
  assert.deepEqual(result.visibility.effective, {});
  assert.deepEqual(result.visibility.groupEffective, {});
});

test("an explicit nonlive terminal completes without waiting for machine readiness", () => {
  const result = applyHiddenRemovals({
    visibility: baseVisibility,
    pending: [removal()],
    terminals: [ended("t1", 10)],
    machines: [],
  });

  assert.deepEqual(result.pending, []);
  assert.equal(result.listings.records["record-1"], true);
});

test("keeps absent remote targets through startup and offline states", () => {
  const event = removal("remote-close", {
    targets: [{ address: "builder/t1", created_ms: 10 }],
    recordKeys: ["remote-record"],
    group: group("remote-project", "builder", "/work/project"),
  });

  for (const machines of [[], [loading("builder")], [offline("builder")]]) {
    const result = applyHiddenRemovals({ pending: [event], terminals: [], machines });
    assert.deepEqual(result.pending, [event]);
    assert.equal(result.listings.records["remote-record"], undefined);
  }

  const readyResult = applyHiddenRemovals({ pending: [event], terminals: [], machines: [ready("builder")] });
  assert.deepEqual(readyResult.pending, []);
  assert.equal(readyResult.listings.records["remote-record"], true);
});

test("a reused address with a new epoch proves the original event ended", () => {
  const event = removal("epoch-close");
  const oldEpoch = applyHiddenRemovals({ pending: [event], terminals: [live("t1", 10)], machines: [ready()] });
  const newEpoch = applyHiddenRemovals({ pending: [event], terminals: [live("t1", 11)], machines: [ready()] });

  assert.deepEqual(oldEpoch.pending, [event]);
  assert.deepEqual(newEpoch.pending, []);
  assert.equal(newEpoch.listings.records["record-1"], true);
});

test("a missing creation epoch stays pending while the address is live", () => {
  const event = removal("unknown-epoch", {
    targets: [{ address: "t1", created_ms: null }],
    recordKeys: ["record-unknown"],
  });
  const result = applyHiddenRemovals({ pending: [event], terminals: [live("t1", 11)], machines: [ready()] });

  assert.deepEqual(result.pending, [event]);
});

test("saved-only removal dismisses its record and group without a process operation", () => {
  const event = removal("saved-only", { targets: [], recordKeys: ["saved-record"], group: group() });
  const result = applyHiddenRemovals({
    visibility: baseVisibility,
    listings: null,
    pending: [event],
    terminals: [],
    machines: [],
  });

  assert.deepEqual(result.pending, []);
  assert.equal(result.listings.records["saved-record"], true);
  assert.equal(result.listings.groups[groupListingKey(group())], true);
  assert.equal(result.visibility.groups["group-project"], undefined);
  assert.ok(result.visibility.hidden.t1);
});

test("normalizes records, deduplicates event ids, and never retains raw payloads", () => {
  const event = removal("duplicate", {
    recordKeys: [" record-1 ", "record-1", "record-2"],
    raw: { argv: ["password"], labels: { secret: "value" } },
  });
  const result = applyHiddenRemovals({
    pending: [event, { ...event, raw: { argv: ["different-secret"] } }],
    terminals: [live("t1", 10)],
    machines: [ready()],
  });

  assert.deepEqual(result.pending, [
    {
      id: "duplicate",
      targets: [{ address: "t1", created_ms: 10 }],
      recordKeys: ["record-1", "record-2"],
      group: group(),
    },
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("an invalid target is not treated as a saved-only event", () => {
  const result = applyHiddenRemovals({
    pending: [{ id: "invalid", targets: [{ address: "" }], recordKeys: ["must-remain"] }],
    terminals: [],
    machines: [ready()],
  });

  assert.deepEqual(result.pending, []);
  assert.equal(result.listings.records["must-remain"], undefined);
});

test("deduplicated completed events dismiss once and preserve unrelated hides", () => {
  const event = removal("complete-once", { recordKeys: ["record-1", "record-1"] });
  const result = applyHiddenRemovals({
    visibility: baseVisibility,
    listings: { version: 1, records: { existing: true }, groups: { existingGroup: true } },
    pending: [event, event],
    terminals: [ended("t1", 10)],
    machines: [],
  });

  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.listings.records, { existing: true, "record-1": true });
  assert.deepEqual(result.visibility.hidden, {
    t2: { created_ms: 20, recordKey: "record-2" },
    "remote/t3": { created_ms: 30, recordKey: "record-3" },
  });
  assert.deepEqual(result.visibility.groups, {
    "group-other": { kind: "project", label: "Other", machine: null, folder: "/work/other" },
  });
});
