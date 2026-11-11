import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, inWindow, assessActivity, createQuietTracker, createOvernightUpdater } from "../overnight-update.mjs";

const settings = { enabled: true, startHour: 3, endHour: 6, idleMinutes: 10, probes: [["probe"]] };
const at = (hour, minute = 0) => new Date(2026, 10, 10, hour, minute);

test("the update window uses local time and excludes 6 a.m.", () => {
  assert.equal(inWindow(settings, at(2, 59)), false);
  assert.equal(inWindow(settings, at(3)), true);
  assert.equal(inWindow(settings, at(5, 59)), true);
  assert.equal(inWindow(settings, at(6)), false);
  for (const bad of [{ idleMinutes: 0 }, { startHour: 6 }, { endHour: 25 }, { enabled: "true" }, { probes: [] }]) assert.throws(() => validateConfig({ ...settings, ...bad }));
});

test("all environments need fresh, explicitly idle readings", () => {
  const now = at(3).getTime();
  const reading = { environmentId: "mac", idle: true, revision: "1", checkedAt: now };
  assert.ok(assessActivity(["mac"], [reading], now));
  assert.equal(assessActivity(["mac", "remote"], [reading], now), null);
  for (const changed of [{ unknown: true }, { idle: false }, { checkedAt: now - 16000 }, { checkedAt: now + 16000 }, { revision: null }]) assert.equal(assessActivity(["mac"], [{ ...reading, ...changed }], now), null);
});

test("quiet time resets on activity changes, clock reversal and wake gaps", () => {
  const tracker = createQuietTracker();
  for (let minute = 0; minute < 10; minute++) assert.equal(tracker.ready("revision1", minute * 60000, 600000), false);
  assert.equal(tracker.ready("revision1", 600000, 600000), true);
  assert.equal(tracker.ready("revision2", 660000, 600000), false);
  assert.equal(tracker.ready("revision2", 1300000, 600000), false);
  assert.equal(tracker.ready("revision2", 0, 600000), false);
  assert.equal(tracker.ready(null, 60000, 600000), false);
});

function harness(options = {}) {
  let date = at(3), tick = 0;
  const calls = [], saved = [];
  const page = { environmentIds: ["mac"], inputIdleMs: 3600000, draft: false, update: { enabled: true, status: "downloaded", downloadedVersion: "v2", currentVersion: "v1" } };
  const reading = { environmentId: "mac", idle: true, revision: "1" };
  const updater = createOvernightUpdater({
    config: async () => settings,
    now: () => date,
    monotonic: () => tick,
    idle: async () => 3600000,
    sessions: () => new Map([["target", "session"]]),
    send: async (method, params) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "target", type: "page", url: "t3code://app/" }] };
      if (params.expression.includes("getLocalEnvironmentBootstraps")) return { result: { value: structuredClone(page) } };
      calls.push(params.expression);
      return { result: { value: { accepted: true } } };
    },
    readAttempt: async () => null,
    save: async (record) => saved.push(record),
    probe: async () => ({ ...reading, checkedAt: date.getTime() }),
    log: () => {},
    ...options,
  });
  return { updater, calls, saved, page, reading, async advance(minutes = 1) { date = new Date(date.getTime() + minutes * 60000); tick += minutes * 60000; await updater.tick(); }, setDate(value) { date = value; } };
}

async function quietNight(h) {
  await h.updater.tick();
  for (let i = 0; i < 10; i++) await h.advance();
}

test("only installs a downloaded exact version after continuous quiet, and once per night", async () => {
  const h = harness();
  await quietNight(h);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0], /installUpdate\("v2"\)/);
  assert.equal(h.saved.length, 1);
  for (let i = 0; i < 20; i++) await h.advance();
  assert.equal(h.calls.length, 1);
  const restart = harness({ readAttempt: async () => h.saved[0] });
  await quietNight(restart);
  assert.equal(restart.calls.length, 0);
});

test("busy work, missing coverage, drafts and recent system input all defer installation", async () => {
  for (const change of [h => { h.reading.idle = false; }, h => { h.page.environmentIds.push("remote"); }, h => { h.page.draft = true; }, h => { h.page.inputIdleMs = 500; }]) {
    const h = harness(); change(h); await quietNight(h); assert.equal(h.calls.length, 0);
  }
  const activeMac = harness({ idle: async () => 500 });
  await quietNight(activeMac);
  assert.equal(activeMac.calls.length, 0);
});

test("a lost probe, unknown window or unsupported bridge never permits an install", async () => {
  for (const options of [
    { probe: async () => { throw new Error("offline"); } },
    { sessions: () => new Map() },
    { send: async (method) => method === "Target.getTargets" ? { targetInfos: [{ targetId: "target", type: "page", url: "t3code://app/" }] } : { exceptionDetails: {} } },
  ]) {
    const h = harness(options); await quietNight(h); assert.equal(h.saved.length, 0);
  }
});

test("the fresh final check cancels if activity changes during preparation", async () => {
  let probes = 0;
  const h = harness({ probe: async () => ({ environmentId: "mac", checkedAt: at(3, Math.min(probes, 10)).getTime(), idle: ++probes <= 11, revision: "1" }) });
  await quietNight(h);
  assert.equal(h.saved.length, 0);
  assert.equal(h.calls.length, 0);
});

test("crossing the window boundary or failing to persist the attempt prevents installation", async () => {
  const h = harness();
  await h.updater.tick();
  for (let i = 0; i < 9; i++) await h.advance();
  h.setDate(at(6)); await h.advance();
  assert.equal(h.calls.length, 0);
  const failingState = harness({ save: async () => { throw new Error("disk full"); } });
  await quietNight(failingState);
  assert.equal(failingState.calls.length, 0);
});

test("checks and downloads through the official bridge without installing an unprepared release", async () => {
  const h = harness({ send: async (method, params) => {
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "target", type: "page", url: "t3code://app/" }] };
    if (params.expression.includes("getLocalEnvironmentBootstraps")) return { result: { value: { environmentIds: ["mac"], inputIdleMs: 3600000, draft: false, update: { enabled: true, status: "idle" } } } };
    h.calls.push(params.expression);
    return { result: { value: { enabled: true, status: "available" } } };
  } });
  await quietNight(h);
  assert.ok(h.calls.some(call => call.includes("checkForUpdate")));
  assert.ok(h.calls.some(call => call.includes("downloadUpdate")));
  assert.equal(h.calls.some(call => call.includes("installUpdate")), false);
});

import vm from "node:vm";
import { pageSnapshot } from "../overnight-update.mjs";

const snapshotContext = ({ local = [{ id: "primary", httpBaseUrl: "http://127.0.0.1:3773/" }], disabled = ["disabled"], fetch = async (url) => ({ ok: String(url) === "http://127.0.0.1:3773/.well-known/t3/environment", json: async () => ({ environmentId: "mac" }) }) } = {}) => vm.createContext({ URL, fetch, window: {
  __t3Overnight: { inputIdleMs: () => 3600000, hasDraft: () => false },
  desktopBridge: {
    getConnectionCatalog: async () => JSON.stringify({ schemaVersion: 1, targets: [{ environmentId: "remote" }, { environmentId: "disabled" }], disabledEnvironmentIds: disabled, credentials: [{ credential: { token: "never-export-me" } }] }),
    getLocalEnvironmentBootstraps: () => local,
    getUpdateState: async () => ({ enabled: true, status: "downloaded" }),
    installUpdate: async () => { throw new Error("must not install during reads"); },
  },
} });

test("renderer snapshot covers local and enabled remote environments without returning catalog credentials", async () => {
  const result = await vm.runInContext(`(${pageSnapshot})()`, snapshotContext());
  assert.deepEqual(Array.from(result.environmentIds), ["mac", "remote"]);
  assert.ok(!JSON.stringify(result).includes("never-export-me"));
});

test("renderer snapshot resolves a local bootstrap alias to the environment ID its server reports", async () => {
  // Desktop T3 labels its own backend "primary"; activity probes report the server's real ID.
  const result = await vm.runInContext(`(${pageSnapshot})()`, snapshotContext());
  assert.ok(!result.environmentIds.includes("primary"));
  assert.ok(result.environmentIds.includes("mac"));
});

test("renderer snapshot honors a disabled local environment by its real ID", async () => {
  const result = await vm.runInContext(`(${pageSnapshot})()`, snapshotContext({ disabled: ["mac"] }));
  assert.deepEqual(Array.from(result.environmentIds), ["disabled", "remote"]);
});

test("renderer snapshot fails when a local environment cannot report its ID", async () => {
  for (const fetch of [async () => ({ ok: false, json: async () => ({}) }), async () => ({ ok: true, json: async () => ({ environmentId: "" }) }), async () => { throw new Error("offline"); }]) {
    await assert.rejects(vm.runInContext(`(${pageSnapshot})()`, snapshotContext({ fetch })));
  }
  await assert.rejects(vm.runInContext(`(${pageSnapshot})()`, snapshotContext({ local: [{ id: "primary" }] })));
});
