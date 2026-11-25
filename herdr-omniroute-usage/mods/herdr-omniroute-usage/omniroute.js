import { URL } from "url";

const SAFE_ERRORS = new Map([[401, "OmniRoute authentication failed."], [403, "OmniRoute access denied."], [404, "OmniRoute endpoint not found."], [429, "OmniRoute is rate limiting requests."]]);
let codexAccounts = new Set();

function baseUrl(config) {
  try {
    const url = new URL(config?.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("HTTPS is required for remote OmniRoute instances.");
    }
    return url.href.replace(/\/+$/, "");
  } catch (error) {
    throw new Error(error.message === "HTTPS is required for remote OmniRoute instances." ? error.message : "Enter a valid OmniRoute URL.");
  }
}

async function request(config, path, options = {}) {
  const base = baseUrl(config);
  const token = typeof config?.token === "string" ? config.token.trim() : "";
  if (!token) throw new Error("Enter an OmniRoute access token.");
  let response;
  try {
    response = await fetch(`${base}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  } catch {
    throw new Error("Could not reach OmniRoute.");
  }
  if (!response.ok) throw new Error(SAFE_ERRORS.get(response.status) || `OmniRoute request failed (HTTP ${response.status}).`);
  try { return await response.json(); } catch { throw new Error("OmniRoute returned an invalid response."); }
}

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const label = (value, fallback) => typeof value === "string" && value.trim() ? value.trim() : fallback;
const errorText = (error) => error instanceof Error ? error.message : "OmniRoute request failed.";

export async function testConnection(config) {
  const result = await request(config, "/api/cli/whoami");
  if (result?.authenticated !== true || result?.viaAccessToken !== true || !["read", "write"].includes(result.scope)) {
    throw new Error("Use a read- or write-scoped OmniRoute access token.");
  }
  if (config.redemptionEnabled && result.scope !== "write") throw new Error("Codex redemption requires a write-scoped access token.");
  return result;
}

const walletCurrency = (key, quota) => quota.unlimited === true && /^credits_[a-z]{3}$/i.test(key)
  ? key.slice(-3).toUpperCase() : null;

function walletBalances(cache) {
  const balances = [];
  for (const [key, value] of Object.entries(record(cache?.quotas))) {
    const quota = record(value);
    const currency = walletCurrency(key, quota);
    if (currency && Number.isFinite(quota.remaining)) balances.push({ currency, amount: quota.remaining });
  }
  return balances;
}

export function summarizeBalances(accounts) {
  const totals = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    for (const balance of Array.isArray(account?.balances) ? account.balances : []) {
      if (typeof balance?.currency !== "string" || !balance.currency || typeof balance.amount !== "number" || !Number.isFinite(balance.amount)) continue;
      totals.set(balance.currency, (totals.get(balance.currency) ?? 0) + balance.amount);
    }
  }
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

function quotaWindows(cache) {
  const found = [];
  for (const [key, value] of Object.entries(record(cache?.quotas))) {
    const quota = record(value);
    if (walletCurrency(key, quota)) continue;
    const used = typeof quota.usedPercentage === "number" && Number.isFinite(quota.usedPercentage) ? quota.usedPercentage : null;
    const remaining = typeof quota.remainingPercentage === "number" && Number.isFinite(quota.remainingPercentage) ? quota.remainingPercentage : typeof quota.remaining_percent === "number" && Number.isFinite(quota.remaining_percent) ? quota.remaining_percent : null;
    const counterPercent = quota.unlimited !== true && quota.fractionReported !== false &&
      Number.isFinite(quota.total) && quota.total > 0 && Number.isFinite(quota.used)
      ? 100 * (1 - quota.used / quota.total) : null;
    const percent = used !== null ? 100 - used : remaining ?? counterPercent;
    if (percent === null) continue;
    found.push({ id: key, label: label(quota.displayName ?? quota.name, key), remaining: Math.max(0, Math.min(100, percent)), resetAt: quota.resetAt ?? quota.reset_at ?? null });
  }
  return found;
}

export async function loadUsage(config, previous = []) {
  const [providerResult, limitResult] = await Promise.allSettled([
    request(config, "/api/providers"),
    request(config, "/api/usage/provider-limits"),
  ]);
  if (providerResult.status === "rejected") throw providerResult.reason;
  if (!Array.isArray(providerResult.value?.connections)) throw new Error("OmniRoute returned an invalid account inventory.");
  const connections = providerResult.value.connections.filter((c) => c && typeof c.id === "string" && c.id && typeof c.provider === "string" && c.provider);
  codexAccounts = new Set(connections.filter((c) => c.provider === "codex").map((c) => c.id));
  const limitData = limitResult.status === "fulfilled" ? limitResult.value : null;
  const validCache = limitData?.caches && typeof limitData.caches === "object" && !Array.isArray(limitData.caches);
  const caches = record(limitData?.caches);
  const oldAccounts = new Map(previous.flatMap((provider) => provider.accounts.map((account) => [account.id, account])));
  const staleAfterMs = Number.isFinite(limitData?.intervalMinutes) && limitData.intervalMinutes > 0
    ? limitData.intervalMinutes * 60_000 : null;
  const accounts = await Promise.all(connections.map(async (connection) => {
    const cache = caches[connection.id];
    const account = { id: connection.id, label: label(connection.name, `${connection.provider} account`), active: connection.isActive !== false,
      windows: quotaWindows(cache), balances: walletBalances(cache), fetchedAt: cache?.fetchedAt ?? null, staleAfterMs, credits: [], creditCount: 0 };
    if (connection.provider === "codex") {
      const plans = [cache?.plan, connection.providerSpecificData?.workspacePlanType, connection.providerSpecificData?.chatgptPlanType];
      account.plan = plans.map((value) => typeof value === "string" ? value.trim().toLowerCase() : "")
        .find((value) => value && value !== "unknown") ?? null;
    }
    if (limitResult.status === "rejected") account.quotaError = errorText(limitResult.reason);
    else if (!validCache) account.quotaError = "OmniRoute returned an invalid quota cache.";
    else if (cache?.message) account.quotaError = "OmniRoute reported a quota refresh failure.";
    const prior = oldAccounts.get(connection.id);
    if (account.quotaError && prior && !account.windows.length && !account.balances.length) {
      account.windows = prior.windows;
      account.balances = prior.balances;
      account.fetchedAt = prior.fetchedAt;
      account.staleAfterMs = prior.staleAfterMs;
    }
    if (["codex", "claude", "grok-cli"].includes(connection.provider)) {
      try {
        const result = await request(config, `/api/usage/codex-reset-credit?connectionId=${encodeURIComponent(account.id)}`);
        account.credits = Array.isArray(result?.credits) ? result.credits.filter((credit) => typeof credit?.selectionToken === "string" && credit.selectionToken).map((credit) => ({ selectionToken: credit.selectionToken, expiresAt: credit.expiresAt ?? null })) : [];
        account.creditCount = Number.isFinite(Number(result?.availableCount)) ? Math.max(0, Number(result.availableCount)) : account.credits.length;
      } catch (error) { account.creditError = errorText(error); }
    }
    return account;
  }));
  return [...new Set(connections.map((c) => c.provider))].map((id) => ({ id, label: id, accounts: accounts.filter((_, index) => connections[index].provider === id) }));
}

export async function redeemCredit(config, connectionId, selectionToken, idempotencyKey) {
  if (!config.redemptionEnabled) throw new Error("Enable Codex redemption in Connection settings first.");
  if (!codexAccounts.has(connectionId)) throw new Error("Reset credits can only be redeemed for Codex accounts.");
  if (![connectionId, selectionToken, idempotencyKey].every((value) => typeof value === "string" && value.trim())) throw new Error("Select a credit before redeeming it.");
  const result = await request(config, "/api/usage/codex-reset-credit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId, idempotencyKey, creditId: selectionToken }) });
  if (result?.ok !== true || !["reset", "alreadyRedeemed"].includes(result.outcome)) {
    throw new Error("OmniRoute did not confirm redemption. Check the refreshed credit list before trying again.");
  }
  return result;
}

export function summarize(accounts, windowIds) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const ids = Array.isArray(windowIds) ? windowIds : [windowIds];
  const values = accounts.map((account) => {
    const windows = Array.isArray(account?.windows) ? account.windows : [];
    const selected = windows.filter((window) => ids.includes(window.id));
    if (ids.length === 0 || ids.some((id) => !selected.some((window) => window.id === id)) || selected.some((window) => !Number.isFinite(window.remaining))) return null;
    return selected.reduce((sum, window) => sum + window.remaining, 0) / selected.length;
  });
  return values.some((value) => value === null) ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function codexWeight(account, windowId) {
  if (account.plan === "plus") return 1;
  // OmniRoute's totals are normalized to 100, not actual allowance units.
  if (account.plan === "prolite" && windowId === "weekly") return 5;
  return null;
}

export function summarizeCodexFooter(accounts, windowIds) {
  const active = accounts.filter((account) => account.active);
  let reporting = active.length;
  let sum = 0;
  for (const id of windowIds) {
    let windowSum = 0;
    let weightSum = 0;
    let count = 0;
    for (const account of active) {
      const window = account.windows.find((entry) => entry.id === id);
      const weight = codexWeight(account, id);
      if (!Number.isFinite(window?.remaining) || weight === null) continue;
      windowSum += window.remaining * weight;
      weightSum += weight;
      count++;
    }
    reporting = Math.min(reporting, count);
    if (!count) return { value: null, reporting: 0, total: active.length };
    sum += windowSum / weightSum;
  }
  return { value: windowIds.length ? sum / windowIds.length : null, reporting, total: active.length };
}
