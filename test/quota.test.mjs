import { test } from "node:test";
import assert from "node:assert/strict";
import { claudePlan, pooledWindow, poolRecovery, readQuotas } from "../quota.mjs";

const now = Date.now();
const account = (plan, used, resetAt = now + 3600000) => ({
  id: plan, provider: "claude", plan, models: ["claude-opus-5-5"],
  windows: { session: { used, resetAt } },
});

test("profile tiers distinguish Pro, Max 5× and Max 20×", () => {
  assert.equal(claudePlan({ organization: { organization_type: "claude_pro" } }), "Pro");
  for (const n of [5, 20]) assert.equal(claudePlan({ organization: { organization_type: "claude_max", rate_limit_tier: `default_claude_max_${n}x` } }), `Max ${n}×`);
  assert.equal(claudePlan(null), "Subscription");
});

test("a spent Max 20× contributes twenty Pro allowances to the pool", () => {
  const pool = pooledWindow([account("Max 20×", 100), account("Max 5×", 82)], "session");
  assert.equal(pool.remaining, 4);
  assert.equal(pool.weighted, true);
  assert.deepEqual(pool.members.map((member) => member.weight), [20, 5]);
});

test("weekly and unknown tiers stay explicitly unweighted", () => {
  assert.equal(pooledWindow([account("Team", 100), account("Pro", 0)], "session").weighted, false);
  const weekly = [account("Max 20×", 100), account("Pro", 0)].map((a) => ({ ...a, windows: { weekly: a.windows.session } }));
  assert.equal(pooledWindow(weekly, "weekly").remaining, 50);
  assert.equal(pooledWindow(weekly, "weekly").weighted, false);
});

test("weekly exhaustion suppresses the account's usable session allowance", () => {
  const a = account("Max 20×", 0);
  a.windows.weekly = { used: 100, resetAt: now + 86400000 };
  assert.equal(pooledWindow([a, account("Pro", 0)], "session").remaining, 5);
});

test("recovery waits for a whole eligible account and preserves uncertainty", () => {
  const a = account("Pro", 100, now + 3600000);
  a.windows.weekly = { used: 100, resetAt: now + 10800000 };
  const b = account("Max 20×", 100, now + 7200000);
  assert.equal(poolRecovery([a, b], "claude-opus-5-5", now).resetAt, now + 7200000);
  for (const bad of [account("Pro", 30), { ...a, unavailable: true }, { ...a, models: null }, account("Pro", 100, now - 1)]) {
    assert.equal(poolRecovery([bad, b], "claude-opus-5-5", now), null);
  }
  assert.equal(poolRecovery([a], "gpt-6.1-sol", now), null);
});

test("the public account data contains no credentials and survives a failed profile", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer private-management-key");
    if (url.endsWith("auth-files")) return Response.json({ files: [{ id: "a", provider: "claude", auth_index: "one", email: "a@example.com" }] });
    const call = JSON.parse(options.body);
    assert.equal(call.header.Authorization, "Bearer $TOKEN$");
    return Response.json({ status_code: call.url.endsWith("profile") ? 403 : 200, body: JSON.stringify({ five_hour: { utilization: 75, resets_at: new Date(now + 3600000).toISOString() } }) });
  };
  const result = await readQuotas({ url: "http://hub", managementKey: "private-management-key" }, { fetchImpl });
  assert.equal(result.accounts[0].plan, "Subscription");
  assert.equal(result.accounts[0].windows.session.used, 75);
  assert.ok(!JSON.stringify(result).includes("private-management-key"));
});

test("model-scoped exhaustion delays only matching models and unknown scopes prevent guessing", () => {
  const a = account("Pro", 100);
  a.scoped = [{ used: 100, resetAt: now + 7200000, scope: "opus" }];
  assert.equal(poolRecovery([a], "claude-opus-5-5", now).resetAt, now + 7200000);
  a.models.push("claude-sonnet-5");
  assert.equal(poolRecovery([a], "claude-sonnet-5", now).resetAt, now + 3600000);
  a.scoped[0].scope = undefined;
  assert.equal(poolRecovery([a], "claude-opus-5-5", now), null);
});
