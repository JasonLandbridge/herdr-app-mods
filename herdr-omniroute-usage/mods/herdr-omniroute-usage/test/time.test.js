import { test } from "node:test";
import assert from "node:assert/strict";
import { eventTime, timestampLabel } from "../time.js";

const reset = "2026-11-25T03:15:00Z";
const end = Date.parse(reset);
const countdown = { timeMode: "countdown", dateFormat: "system" };

test("countdowns update, round up partial minutes, and never infer replenishment", () => {
  assert.equal(eventTime(reset, countdown, end - 8_101_000), "Resets in 2h 16m");
  assert.equal(eventTime(reset, countdown, end - 8_100_000), "Resets in 2h 15m");
  assert.equal(eventTime(reset, countdown, end - 1), "Resets in 1m");
  assert.equal(eventTime(reset, countdown, end), "Reset due");
  assert.equal(eventTime(reset, countdown, end + 1, true), "Expired");
  assert.equal(eventTime(null, countdown, end), null);
  assert.equal(eventTime("invalid", countdown, end, true), "Expiry not reported");
});

test("timestamp presets use local time for reset and expiry labels", () => {
  const local = new Date(2026, 10, 25, 13, 5);
  assert.equal(timestampLabel(local.getTime(), "system"), local.toLocaleString());
  assert.equal(timestampLabel(local.getTime(), "12h"), "2026-11-25 1:05 PM");
  assert.equal(timestampLabel(local.getTime(), "24h"), "2026-11-25 13:05");
  const iso = { timeMode: "timestamp", dateFormat: "iso" };
  assert.equal(eventTime(local.toISOString(), iso, local.getTime() - 1), "Resets 2026-11-25T13:05");
  assert.equal(eventTime(local.toISOString(), iso, local.getTime() - 1, true), "Expires 2026-11-25T13:05");
});
