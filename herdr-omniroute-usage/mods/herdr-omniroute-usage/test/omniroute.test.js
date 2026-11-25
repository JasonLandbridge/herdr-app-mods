import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUsage, redeemCredit, summarize, summarizeBalances, summarizeCodexFooter, testConnection } from "../omniroute.js";

const config = { url: "http://localhost:3456", token: "secret" };
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => handler(String(url), options);
  return () => { globalThis.fetch = original; };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("read tokens monitor quota but cannot enable redemption", async () => {
  const restore = mockFetch(() => json({ authenticated: true, viaAccessToken: true, scope: "read" }));
  try {
    assert.equal((await testConnection(config)).scope, "read");
    await assert.rejects(testConnection({ ...config, redemptionEnabled: true }), /write-scoped/);
  } finally { restore(); }
});

test("a non-credit provider remains in the configured inventory", async () => {
  const restore = mockFetch((url) => url.includes("/api/providers") ? json({ connections: [{ id: "api", provider: "openrouter", name: "API" }] }) : json({ caches: { api: { quotas: { balance: { usedPercentage: null, remainingPercentage: null } } } } }));
  try {
    const [provider] = await loadUsage(config);
    assert.equal(provider.accounts[0].id, "api");
    assert.equal(provider.accounts[0].credits.length, 0);
    assert.equal(provider.accounts[0].windows.length, 0);
  } finally { restore(); }
});
test("parses OmniRoute wallet credits without treating unlimited quotas as wallet balances", async () => {
  const restore = mockFetch((url) => url.includes("/api/providers")
    ? json({ connections: [
      { id: "usd", provider: "deepseek", name: "DeepSeek USD" },
      { id: "cny", provider: "deepseek", name: "DeepSeek CNY" },
      { id: "free", provider: "deepseek", name: "Unlimited" },
      { id: "unknown", provider: "openrouter", name: "No wallet" },
    ] })
    : json({ caches: {
      usd: { quotas: { credits_usd: { remaining: 12.5, remainingPercentage: 100, unlimited: true }, credits_cny: { remaining: 3, unlimited: true } } },
      cny: { quotas: { credits_usd: { remaining: 7, unlimited: true }, credits_cny: { remaining: 0, unlimited: true } } },
      free: { quotas: { requests: { usedPercentage: 0, remainingPercentage: 100 } } },
      unknown: { quotas: { credits_usd: {} } },
    } }));
  try {
    const providers = await loadUsage(config);
    const deepseek = providers.find((provider) => provider.id === "deepseek");
    assert.deepEqual(deepseek.accounts.map(({ balances }) => balances), [
      [{ currency: "USD", amount: 12.5 }, { currency: "CNY", amount: 3 }],
      [{ currency: "USD", amount: 7 }, { currency: "CNY", amount: 0 }],
      [],
    ]);
    assert.deepEqual(deepseek.accounts.map(({ windows }) => windows.map(({ id }) => id)), [[], [], ["requests"]]);
    assert.deepEqual(summarizeBalances(deepseek.accounts), [
      { currency: "USD", amount: 19.5 },
      { currency: "CNY", amount: 3 },
    ]);
    assert.deepEqual(summarizeBalances([{ balances: [{ currency: "USD", amount: 0 }, { currency: "CNY" }] }]), [
      { currency: "USD", amount: 0 },
    ]);
  } finally { restore(); }
});


test("preserves configured accounts and separates quota failures from credit-list failures", async () => {
  const restore = mockFetch((url) => {
    if (url.includes("/api/providers")) return json({ connections: [
      { id: "c1", provider: "codex", name: "Codex" },
      { id: "c2", provider: "claude", name: "Claude" },
      { id: "g1", provider: "grok-cli", name: "Grok" },
    ] });
    if (url.includes("provider-limits")) return json({ caches: { c1: { quotas: { session: { usedPercentage: 25, resetAt: "tomorrow" } } }, c2: { message: "Provider limits unavailable", quotas: null } } });
    if (url.includes("connectionId=c1")) return json({ credits: [{ selectionToken: "opaque", expiresAt: "soon" }], availableCount: 1 });
    if (url.includes("connectionId=c2")) return json({ error: "private upstream detail" }, 502);
    return json({ credits: [], availableCount: 0 });
  });
  try {
    const data = await loadUsage(config);
    assert.deepEqual(data.map((p) => p.id), ["codex", "claude", "grok-cli"]);
    assert.deepEqual(data[0].accounts[0].windows, [{ id: "session", label: "session", remaining: 75, resetAt: "tomorrow" }]);
    assert.deepEqual(data[0].accounts[0].credits, [{ selectionToken: "opaque", expiresAt: "soon" }]);
    assert.equal(data[1].accounts[0].quotaError, "OmniRoute reported a quota refresh failure.");
    assert.equal(data[1].accounts[0].creditError, "OmniRoute request failed (HTTP 502).");
    assert.equal(data[2].accounts[0].quotaError, undefined);
    assert.deepEqual(data[2].accounts[0].windows, []);
  } finally { restore(); }
});

test("a provider-list failure stops the load; a limits endpoint failure still preserves accounts", async () => {
  let restore = mockFetch((url) => url.includes("/api/providers") ? json({ error: "private" }, 403) : json({}));
  try { await assert.rejects(loadUsage(config), /OmniRoute access denied/); } finally { restore(); }
  const providers = { connections: [{ id: "a", provider: "codex" }] };
  const fetchedAt = "2026-11-24T08:00:00Z";
  restore = mockFetch((url) => url.includes("/api/providers") ? json(providers) : url.includes("provider-limits") ? json({ intervalMinutes: 70, caches: { a: { fetchedAt, quotas: { session: { usedPercentage: 25 } } } } }) : json({ credits: [] }));
  let previous;
  try { previous = await loadUsage(config); } finally { restore(); }
  restore = mockFetch((url) => url.includes("/api/providers") ? json(providers) : url.includes("provider-limits") ? json({}, 503) : json({ credits: [] }));
  try {
    const [account] = (await loadUsage(config, previous))[0].accounts;
    assert.equal(account.id, "a");
    assert.equal(account.quotaError, "OmniRoute request failed (HTTP 503).");
    assert.equal(account.fetchedAt, fetchedAt);
    assert.equal(account.staleAfterMs, 70 * 60_000);
    assert.equal(account.windows[0].remaining, 75);
    assert.equal(account.creditError, undefined);
  } finally { restore(); }
});

test("rejects remote plaintext and URL credentials before sending a token", async () => {
  const restore = mockFetch(() => assert.fail("must not dispatch"));
  try {
    await assert.rejects(testConnection({ ...config, url: "http://example.com" }), /HTTPS is required/);
    await assert.rejects(testConnection({ ...config, url: "https://user:pass@example.com" }), /valid OmniRoute URL/);
  } finally { restore(); }
});

test("redeems only the exact selected token with a supplied idempotency key", async () => {
  const load = mockFetch((url) => url.includes("/api/providers") ? json({ connections: [{ id: "a", provider: "codex" }] }) : url.includes("provider-limits") ? json({ caches: {} }) : json({ credits: [] }));
  try { await loadUsage(config); } finally { load(); }
  const restore = mockFetch((url, options) => {
    assert.equal(url, `${config.url}/api/usage/codex-reset-credit`);
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { connectionId: "a", idempotencyKey: "uuid", creditId: "exact-token" });
    return json({ ok: true, outcome: "reset" });
  });
  try {
    await assert.rejects(redeemCredit(config, "a", "exact-token", "uuid"), /Enable Codex redemption/);
    const enabled = { ...config, redemptionEnabled: true };
    assert.equal((await redeemCredit(enabled, "a", "exact-token", "uuid")).ok, true);
    await assert.rejects(redeemCredit(enabled, "not-codex", "token", "uuid"), /only be redeemed for Codex/);
  } finally { restore(); }
});

test("averages windows per account and accounts equally; missing Mixed window stays unknown", () => {
  assert.equal(summarize([
    { windows: [{ id: "session", remaining: 80 }, { id: "weekly", remaining: 40 }] },
    { windows: [{ id: "session", remaining: 20 }, { id: "weekly", remaining: 60 }] },
  ], ["session", "weekly"]), 50);
  assert.equal(summarize([{ windows: [{ id: "session", remaining: 80 }] }, { windows: [] }], "session"), null);
  assert.equal(summarize([{ windows: [{ id: "session", remaining: 80 }] }], ["session", "weekly"]), null);
});

test("Codex Mixed uses counter-based quota and excludes the disabled account from the footer", async () => {
  const restore = mockFetch((url) => {
    if (url.includes("/api/providers")) return json({ connections: [
      { id: "working", provider: "codex", isActive: true, providerSpecificData: { workspacePlanType: "plus" } },
      { id: "disabled", provider: "codex", isActive: false },
      { id: "weekly-only", provider: "codex", isActive: true, providerSpecificData: { workspacePlanType: "plus" } },
    ] });
    if (url.includes("provider-limits")) return json({ caches: {
      working: { quotas: { session: { total: 100, used: 25, remaining: null }, weekly: { total: 100, used: 75, remaining: null } } },
      disabled: { quotas: { weekly: { total: 100, used: 100, remaining: null } } },
      "weekly-only": { quotas: { weekly: { total: 100, used: 1 } } },
    } });
    return json({ credits: [] });
  });
  try {
    const [{ accounts }] = await loadUsage(config);
    assert.deepEqual(summarizeCodexFooter(accounts, ["session", "weekly"]), { value: 68.5, reporting: 1, total: 2 });
    assert.equal(accounts[1].windows[0].remaining, 0);
    assert.deepEqual(summarizeCodexFooter(accounts, ["session"]), { value: 75, reporting: 1, total: 2 });
    assert.deepEqual(summarizeCodexFooter(accounts, ["weekly"]), { value: 62, reporting: 2, total: 2 });
    assert.deepEqual(summarizeCodexFooter(accounts, ["unreported"]), { value: null, reporting: 0, total: 2 });
  } finally { restore(); }
});

test("Codex weekly totals weight the Pro Lite account even without a session window", async () => {
  const plans = ["plus", "plus", "plus", "prolite"];
  const weekly = [7, 86, 100, 92];
  const restore = mockFetch((url) => {
    if (url.includes("/api/providers")) return json({ connections: plans.map((plan, id) => ({
      id: String(id), provider: "codex", isActive: true, providerSpecificData: { workspacePlanType: plan },
    })) });
    if (url.includes("provider-limits")) return json({ caches: Object.fromEntries(weekly.map((remainingPercentage, id) => [id, { quotas: {
      weekly: { remainingPercentage, total: 100 },
      ...(id < 3 ? { session: { remainingPercentage: 100 } } : {}),
    } }])) });
    return json({ credits: [] });
  });
  try {
    const [{ accounts }] = await loadUsage(config);
    assert.deepEqual(summarizeCodexFooter(accounts, ["weekly"]), { value: 81.625, reporting: 4, total: 4 });
    assert.deepEqual(summarizeCodexFooter(accounts, ["session", "weekly"]), { value: 90.8125, reporting: 3, total: 4 });
  } finally { restore(); }
});

test("unmapped Codex plans do not silently count as 1×", () => {
  const accounts = [
    { id: "plus", active: true, plan: "plus", windows: [{ id: "session", remaining: 100 }, { id: "weekly", remaining: 80 }] },
    { id: "custom", active: true, plan: "new-tier", windows: [{ id: "session", remaining: 50 }, { id: "weekly", remaining: 20 }] },
  ];
  assert.deepEqual(summarizeCodexFooter(accounts, ["weekly"]), { value: 80, reporting: 1, total: 2 });
  assert.deepEqual(summarizeCodexFooter(accounts.slice(1), ["weekly"]), { value: null, reporting: 0, total: 1 });
});
