import { readFile } from "node:fs/promises";

export const configUrl = new URL("./quota-config.json", import.meta.url);

export async function readConfig() {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const url = new URL(config.url);
  if (!["http:", "https:"].includes(url.protocol) || !config.managementKey) {
    throw new Error("CLIProxy usage is not configured.");
  }
  return { url: url.origin, managementKey: config.managementKey };
}

export function claudePlan(profile) {
  const org = profile?.organization;
  const type = org?.organization_type;
  const multiplier = /_(5|20)x$/.exec(org?.rate_limit_tier ?? "")?.[1];
  if (type === "claude_max") return multiplier ? `Max ${multiplier}×` : "Max";
  if (type === "claude_pro") return "Pro";
  if (type === "claude_team") {
    const seat = /_(standard|premium)$/.exec(org?.seat_tier ?? "")?.[1];
    if (seat) return seat === "premium" ? "Team Premium" : "Team Standard";
    return multiplier ? `Team ${multiplier}×` : "Team";
  }
  if (type === "claude_enterprise") return "Enterprise";
  return "Subscription";
}

const codexPlans = {
  free: "Free", plus: "Plus", prolite: "Pro 100", pro: "Pro 200", promax: "Pro 500",
  team: "Business", business: "Business", self_serve_business_prolite: "Business Premium",
};

export function planWeight(account, window) {
  if (account.provider === "claude" && window === "session") {
    // Team seats: support.claude.com/en/articles/9266767 (per-session allowance relative to Pro).
    return { Pro: 1, "Max 5×": 5, "Max 20×": 20, "Team Standard": 1.25, "Team Premium": 6.25 }[account.plan];
  }
  // Standard Business shares Plus's published limits (learn.chatgpt.com/docs/pricing).
  if (account.provider === "codex") return { Plus: 1, "Pro 100": 5, "Pro 200": 20, Business: 1 }[account.plan];
}

const percent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const resetMs = (value) => {
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value ?? "");
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};
const makeWindow = (used, reset) => percent(used) ? { used, resetAt: resetMs(reset) } : null;

export function pooledWindow(accounts, kind, now = Date.now()) {
  const reported = accounts.filter((account) => account.windows?.[kind]);
  if (!reported.length) return null;
  const weighted = reported.every((account) => planWeight(account, kind) !== undefined);
  const members = reported.map((account) => {
    const window = account.windows[kind];
    const weekly = account.windows.weekly;
    const blocked = kind === "session" && weekly?.used >= 100;
    return { account, used: blocked ? 100 : window.used, weight: weighted ? planWeight(account, kind) : 1 };
  });
  const weight = members.reduce((sum, member) => sum + member.weight, 0);
  return {
    remaining: Math.round(members.reduce((sum, member) => sum + (100 - member.used) * member.weight, 0) / weight),
    weighted,
    incomplete: reported.length !== accounts.length,
    members: members.map(({ account, weight }) => ({ id: account.id, weight })),
  };
}

export function poolRecovery(accounts, model, now = Date.now()) {
  accounts = accounts.filter((account) => account.provider === "claude");
  if (typeof model !== "string" || !accounts.length) return null;
  const requested = model.replace(/\[1m\]$/, "");
  // A failed model lookup leaves routing eligibility unknown.
  if (accounts.some((account) => !Array.isArray(account.models))) return null;
  const eligible = accounts.filter((account) => account.models.includes(requested));
  if (!eligible.length) return null;
  const resets = [];
  for (const account of eligible) {
    if (account.unavailable || account.overageEnabled) return null;
    const scoped = account.scoped ?? [];
    const matches = (scope) => scope === null ? true : requested === scope || requested.includes(`-${scope.toLowerCase()}-`);
    // Exhausted scopes we cannot identify make a reset estimate unsafe.
    if (scoped.some((window) => window.used >= 100 && window.scope === undefined)) return null;
    const exhausted = [...Object.entries(account.windows), ...scoped.filter((window) => matches(window.scope)).map((window) => ["scoped", window])].filter(([, window]) => window?.used >= 100);
    if (!exhausted.length || exhausted.some(([, window]) => !window.resetAt || window.resetAt <= now)) return null;
    const [kind, window] = exhausted.reduce((latest, next) => next[1].resetAt > latest[1].resetAt ? next : latest);
    resets.push({ resetAt: window.resetAt, kind });
  }
  return resets.reduce((earliest, next) => next.resetAt < earliest.resetAt ? next : earliest);
}

export async function readQuotas(config, { fetchImpl = fetch, models = false, signal } = {}) {
  const management = async (path, body) => {
    const response = await fetchImpl(`${config.url}/v0/management/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${config.managementKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4500)]) : AbortSignal.timeout(4500),
    });
    if (!response.ok) throw new Error("CLIProxy usage is unavailable.");
    return response.json();
  };
  const listing = await management("auth-files");
  if (!Array.isArray(listing.files)) throw new Error("CLIProxy account list is unavailable.");
  const accounts = await Promise.all(listing.files.filter((file) => !file.disabled && ["claude", "codex"].includes(file.provider)).map(async (file) => {
    const account = { id: file.id, provider: file.provider, name: file.email || file.label || file.id, plan: "Subscription", windows: {} };
    const apiCall = async (url) => {
      const result = await management("api-call", {
        auth_index: file.auth_index, method: "GET", url,
        header: { Authorization: "Bearer $TOKEN$", "User-Agent": file.provider === "claude" ? "claude-code/2.1.319" : "codex_cli_rs",
          ...(file.provider === "claude" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
          ...(file.id_token?.chatgpt_account_id ? { "ChatGPT-Account-Id": file.id_token.chatgpt_account_id } : {}),
        },
      });
      if (result.status_code !== 200) throw new Error("Account usage is unavailable.");
      return JSON.parse(result.body);
    };
    const routes = models ? management(`auth-files/models?name=${encodeURIComponent(file.id)}`)
      .then((result) => Array.isArray(result.models) ? result.models.map((model) => model.id) : null)
      .catch(() => null) : Promise.resolve(undefined);
    try {
      if (file.provider === "claude") {
        const [usage, profile] = await Promise.all([
          apiCall("https://api.anthropic.com/api/oauth/usage"),
          apiCall("https://api.anthropic.com/api/oauth/profile").catch(() => null),
        ]);
        account.plan = claudePlan(profile);
        account.overageEnabled = usage.extra_usage?.is_enabled === true;
        account.scoped = [];
        for (const [key, value] of Object.entries(usage)) {
          if (!key.startsWith("seven_day_") || !value) continue;
          const window = makeWindow(value.utilization, value.resets_at);
          if (window) account.scoped.push({ ...window, scope: ["opus", "sonnet", "haiku", "fable"].includes(key.slice(10)) ? key.slice(10) : undefined });
        }
        for (const limit of usage.limits ?? []) {
          if (["session", "weekly_all"].includes(limit.kind)) continue;
          const window = makeWindow(limit.percent, limit.resets_at);
          if (!window) continue;
          const model = limit.scope?.model;
          const family = model?.display_name?.toLowerCase();
          const scope = !limit.scope ? null : model?.id ?? (["opus", "sonnet", "haiku", "fable"].includes(family) ? family : undefined);
          account.scoped.push({ ...window, scope, label: model?.display_name ?? limit.kind });
        }
        account.windows = {
          session: makeWindow(usage.five_hour?.utilization, usage.five_hour?.resets_at),
          weekly: makeWindow(usage.seven_day?.utilization, usage.seven_day?.resets_at),
        };
      } else {
        const usage = await apiCall("https://chatgpt.com/backend-api/wham/usage");
        account.plan = codexPlans[usage.plan_type ?? file.id_token?.plan_type] ?? "Subscription";
        for (const window of [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window]) {
          if (!window) continue;
          const kind = window.limit_window_seconds >= 604800 ? "weekly" : window.limit_window_seconds > 0 && window.limit_window_seconds <= 18000 ? "session" : null;
          if (kind) account.windows[kind] = makeWindow(window.used_percent, window.reset_at);
        }
      }
      if (!Object.values(account.windows).some(Boolean)) account.unavailable = true;
    } catch {
      account.unavailable = true;
    }
    if (models) account.models = await routes;
    return account;
  }));
  return { checkedAt: Date.now(), accounts };
}

export function publicSnapshot(snapshot) {
  return {
    ...snapshot,
    pools: ["claude", "codex"].map((provider) => {
      const accounts = snapshot.accounts.filter((account) => account.provider === provider);
      return { provider, windows: Object.fromEntries(["session", "weekly"].map((kind) => [kind, pooledWindow(accounts, kind)])) };
    }),
  };
}
