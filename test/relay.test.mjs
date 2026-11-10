import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeResetFrames } from "../provider-relay.mjs";
import { createQuotaBridge } from "../quota-bridge.mjs";

test("a confirmed pool deadline reaches T3 as a native rejected event and preserved 429 result", () => {
  const message = { type: "result", is_error: true, api_error_status: 429, result: "API Error: Request rejected (429)", session_id: "session" };
  const now = Date.now();
  const frames = claudeResetFrames(message, { resetAt: now + 3600000, kind: "session" }, now);
  assert.equal(frames[0].rate_limit_info.status, "rejected");
  assert.equal(frames[0].rate_limit_info.rateLimitType, "five_hour");
  assert.equal(frames[1].api_error_status, 429);
  assert.ok(frames[1].result.endsWith("(reset after 3600s)"));
  assert.deepEqual(claudeResetFrames(message, null), [message]);
  assert.deepEqual(claudeResetFrames({ ...message, api_error_status: 500 }, { resetAt: now + 1 }, now), [{ ...message, api_error_status: 500 }]);
});

test("quota data is returned only to the T3 main frame, never a remote iframe", async () => {
  const sent = [];
  let loads = 0;
  const bridge = createQuotaBridge(async (...args) => sent.push(args), async () => { loads++; return { accounts: [], pools: [] }; });
  const binding = (id) => ({ method: "Runtime.bindingCalled", sessionId: "session", params: { name: "__t3QuotaRequest", payload: "read", executionContextId: id } });
  const context = (id, origin, isDefault) => ({ method: "Runtime.executionContextCreated", sessionId: "session", params: { context: { id, origin, auxData: { isDefault } } } });
  await bridge.event(context(1, "https://untrusted.example", true));
  await bridge.event(binding(1));
  assert.equal(loads, 0);
  await bridge.event(context(2, "t3code://app", true));
  await bridge.event(binding(2));
  await bridge.event(binding(2));
  assert.equal(loads, 1);
  assert.equal(sent.length, 2);
  bridge.forget("session");
  await bridge.event(binding(2));
  assert.equal(sent.length, 2);
});

import { spawn } from "node:child_process";
import { once } from "node:events";
const relayUrl = new URL("../provider-relay.mjs", import.meta.url).href;
async function subprocess(script, { args = ["--output-format=stream-json"], recovery = "async () => null", input = "", keepOpen = false, command = process.execPath } = {}) {
  const code = `import { relay } from ${JSON.stringify(relayUrl)}; process.exitCode = await relay(${JSON.stringify(command)}, ${JSON.stringify(command === process.execPath ? ["-e", script, "--", ...args] : args)}, ${recovery});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => stdout += data);
  child.stderr.on("data", (data) => stderr += data);
  if (keepOpen) child.stdin.write(input);
  else child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 9000);
  const [status, signal] = await once(child, "close");
  clearTimeout(timer);
  return { status, signal, stdout, stderr };
}

test("relay preserves stdin, non-JSON bytes, stderr and exit code", async () => {
  const result = await subprocess(`process.stdin.on('data', data => process.stdout.write(data)); process.stdin.on('end', () => { process.stderr.write('diagnostic'); process.exitCode = 7; });`, { args: [], input: "no trailing newline\u0000bytes" });
  assert.equal(result.stdout, "no trailing newline\u0000bytes");
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.status, 7);
});

test("relay enriches terminal limits and exits even with parent stdin open", async () => {
  const message = { type: "result", is_error: true, api_error_status: 429, result: "exhausted" };
  const script = `console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-opus-5-5'})); console.log(${JSON.stringify(JSON.stringify(message))});`;
  const result = await subprocess(script, { keepOpen: true, recovery: "async () => ({ resetAt: Date.now() + 3600000, kind: 'session' })" });
  assert.equal(result.status, 0);
  const frames = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(frames[1].type, "rate_limit_event");
  assert.equal(frames[2].api_error_status, 429);
  assert.match(frames[2].result, /reset after 3600s/);
});

test("relay bounds unavailable quota lookups and preserves the original error", async () => {
  const message = { type: "result", is_error: true, api_error_status: 429, result: "exhausted" };
  const result = await subprocess(`console.log(${JSON.stringify(JSON.stringify(message))});`, { args: ["--output-format=stream-json", "--model=claude-opus-5-5"], recovery: "async () => new Promise(() => {})", keepOpen: true });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), message);
});

test("relay reports spawn failures without hanging", async () => {
  const result = await subprocess("", { command: "/no-such-t3-quota-provider", keepOpen: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});

test("relay forwards termination to the provider", async () => {
  const code = `import { relay } from ${JSON.stringify(relayUrl)}; process.exitCode = await relay(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"]);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await once(child.stdout, "data");
  child.kill("SIGTERM");
  const [status, signal] = await once(child, "close");
  clearTimeout(timer);
  assert.equal(status, 143);
  assert.equal(signal, null);
});

import { installRelay } from "../install-relay.mjs";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("relay installation is idempotent and restores the exact original executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-relay-"));
  const target = join(root, "claude-cliproxy");
  const original = "#!/bin/sh\nexit 37\n";
  try {
    await writeFile(target, original, { mode: 0o755 });
    await installRelay({ root, target });
    const shim = await readFile(target, "utf8");
    assert.match(shim, /T3_QUOTA_RELAY/);
    await installRelay({ root, target });
    assert.equal(await readFile(target, "utf8"), shim);
    await installRelay({ root, target, uninstall: true });
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal((await stat(target)).mode & 0o777, 0o755);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scoped recovery preserves shared weekly usage and only appends its reset", () => {
  const now = Date.now();
  const message = { type: "result", is_error: true, api_error_status: 429, result: "API Error: exhausted" };
  const frames = claudeResetFrames(message, { resetAt: now + 30000, kind: "scoped" }, now);
  assert.equal(frames.length, 1);
  assert.match(frames[0].result, /reset after 30s/);
});

test("an existing native reset takes precedence over an inferred pool reset", async () => {
  const frames = [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Date.now() / 1000 + 600 } }, { type: "result", is_error: true, api_error_status: 429, result: "API Error: exhausted" }];
  const result = await subprocess(`for (const frame of ${JSON.stringify(frames)}) console.log(JSON.stringify(frame));`, { args: ["--output-format=stream-json", "--model=claude-opus-5-5"], recovery: "async () => ({resetAt:Date.now()+3600000,kind:'session'})" });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n").map(JSON.parse), frames);
});
