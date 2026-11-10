import { readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const configUrl = new URL("./overnight-config.json", import.meta.url);
const stateUrl = new URL("./.overnight-state.json", import.meta.url);

export function validateConfig(config) {
  if (typeof config.enabled !== "boolean" || !Number.isInteger(config.startHour) || !Number.isInteger(config.endHour) || config.startHour < 0 || config.endHour > 24 || config.startHour >= config.endHour || !Number.isFinite(config.idleMinutes) || config.idleMinutes < 10 || config.idleMinutes > 120 || !Array.isArray(config.probes) || !config.probes.length || config.probes.some((p) => !Array.isArray(p) || !p.length || p.some((arg) => typeof arg !== "string" || !arg))) throw new Error("Invalid overnight update config");
  return config;
}

export function inWindow(config, now = new Date()) {
  return now.getHours() >= config.startHour && now.getHours() < config.endHour;
}

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function assessActivity(expectedIds, readings, now = Date.now()) {
  if (!expectedIds.length || !readings.length) return null;
  const ids = new Set();
  for (const reading of readings) {
    if (reading.unknown || reading.idle !== true || !reading.environmentId || typeof reading.revision !== "string" || !Number.isFinite(reading.checkedAt) || now - reading.checkedAt > 15000 || reading.checkedAt - now > 15000) return null;
    ids.add(reading.environmentId);
  }
  if (expectedIds.some((id) => !ids.has(id))) return null;
  return JSON.stringify(readings.map((r) => [r.environmentId, r.revision]).sort());
}

export function createQuietTracker() {
  let since = null, previous = null, lastSample = null;
  return {
    reset() { since = previous = lastSample = null; },
    ready(fingerprint, now, quietMs) {
      if (!fingerprint || lastSample === null || now < lastSample || now - lastSample > 90000 || fingerprint !== previous) since = now;
      previous = fingerprint;
      lastSample = now;
      return Boolean(fingerprint) && now - since >= quietMs;
    },
  };
}

// Return only environment identities; the decrypted catalog (which contains credentials) stays in T3.
export const pageSnapshot = `async () => {
  const bridge = window.desktopBridge;
  const addon = window.__t3Overnight;
  if (!addon || !bridge?.getConnectionCatalog || !bridge.getLocalEnvironmentBootstraps || !bridge.getUpdateState || !bridge.installUpdate) throw new Error('Unsupported desktop bridge');
  const raw = await bridge.getConnectionCatalog();
  const catalog = raw === null ? {schemaVersion:1,targets:[],disabledEnvironmentIds:[]} : JSON.parse(raw);
  if(catalog.schemaVersion !== 1 || !Array.isArray(catalog.targets) || !Array.isArray(catalog.disabledEnvironmentIds)) throw new Error('Unknown catalog');
  const disabled = new Set(catalog.disabledEnvironmentIds);
  const local = bridge.getLocalEnvironmentBootstraps();
  if (!Array.isArray(local)) throw new Error('Unknown local environments');
  const ids = [...local.map(value=>value.id), ...catalog.targets.map(value=>value.environmentId)].filter(id=>!disabled.has(id));
  if (!ids.length || ids.some(id=>typeof id!=='string' || !id)) throw new Error('Missing environment identity');
  return {environmentIds:[...new Set(ids)].sort(),inputIdleMs:addon.inputIdleMs(),draft:addon.hasDraft(),update:await bridge.getUpdateState()};
}`;

export async function systemIdleMs() {
  const { stdout } = await exec("/usr/sbin/ioreg", ["-c", "IOHIDSystem"], { timeout: 4000, maxBuffer: 1024 * 1024 });
  const value = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout)?.[1];
  if (!value) throw new Error("System idle time unavailable");
  return Number(BigInt(value) / 1000000n);
}

export async function readProbe(command) {
  const { stdout } = await exec(command[0], command.slice(1), { timeout: 10000, maxBuffer: 16384 });
  return JSON.parse(stdout);
}

export async function saveAttempt(record) {
  const staging = new URL(`./.overnight-state.${process.pid}.json`, import.meta.url);
  await writeFile(staging, JSON.stringify(record), { mode: 0o600 });
  await rename(staging, stateUrl);
}

export function createOvernightUpdater({ send, sessions, config = async () => validateConfig(JSON.parse(await readFile(configUrl, "utf8"))), probe = readProbe, idle = systemIdleMs, save = saveAttempt, now = () => new Date(), monotonic = () => performance.now(), log = console.log, readAttempt = async () => { try { return JSON.parse(await readFile(stateUrl, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } } }) {
  const quiet = createQuietTracker();
  let pending = false, lastCheck = -Infinity, attemptedDay = null, lastStatus = null, quietSignature = null;
  const status = (text) => { if (text !== lastStatus) { log(`Overnight updates: ${text}`); lastStatus = text; } };
  const evaluate = async (sessionId, expression) => {
    const result = await send("Runtime.evaluate", { expression: `(${expression})()`, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails || !result.result || !("value" in result.result)) throw new Error("Desktop updater unavailable");
    return result.result.value;
  };
  return {
    async tick() {
      if (pending) return;
      pending = true;
      try {
        const settings = await config();
        const date = now();
        if (!settings.enabled || !inWindow(settings, date)) { quiet.reset(); return; }
        const day = localDay(date);
        if (attemptedDay === null) attemptedDay = (await readAttempt())?.day ?? "";
        if (attemptedDay === day) { quiet.reset(); status("already attempted tonight"); return; }
        const targetList = await send("Target.getTargets");
        const appTargets = targetList.targetInfos.filter((target) => target.type === "page" && target.url.startsWith("t3code:"));
        const attached = sessions();
        if (!appTargets.length || appTargets.some((target) => !attached.get(target.targetId))) throw new Error("Window coverage incomplete");
        const ids = appTargets.map((target) => attached.get(target.targetId));
        const quietMs = settings.idleMinutes * 60000;
        const signature = JSON.stringify([settings, appTargets.map(target=>target.targetId).sort()]);
        if (signature !== quietSignature) { quiet.reset(); quietSignature = signature; }
        const read = async () => {
          const pages = await Promise.all(ids.map((id) => evaluate(id, pageSnapshot)));
          const expected = [...new Set(pages.flatMap((p) => p.environmentIds))].sort();
          const readings = await Promise.all(settings.probes.map(probe));
          const fingerprint = assessActivity(expected, readings, now().getTime());
          const idleMs = await idle();
          const safe = fingerprint && Number.isFinite(idleMs) && idleMs >= quietMs && pages.every((page) => Number.isFinite(page.inputIdleMs) && page.inputIdleMs >= quietMs && page.draft === false);
          return { pages, fingerprint: safe ? JSON.stringify([expected, fingerprint]) : null };
        };
        const sample = await read();
        if (!quiet.ready(sample.fingerprint, monotonic(), quietMs)) { status(sample.fingerprint ? `waiting for ${settings.idleMinutes} quiet minutes` : "deferred: busy or activity unknown"); return; }
        const state = sample.pages[0].update;
        if (!state.enabled || state.channelBlockedByPolicy) return;
        if (state.status !== "downloaded") {
          // No installation until the official updater reports a completed download.
          if (monotonic() - lastCheck < 30 * 60000) return;
          lastCheck = monotonic();
          if (["idle", "error"].includes(state.status)) await evaluate(ids[0], "async () => { await window.desktopBridge.checkForUpdate(); return true; }");
          const current = await evaluate(ids[0], "async () => window.desktopBridge.getUpdateState()");
          if (current.enabled && current.status === "available" && inWindow(settings, now())) await evaluate(ids[0], "async () => { await window.desktopBridge.downloadUpdate(); return true; }");
          return;
        }
        if (!state.downloadedVersion || state.downloadedVersion === state.currentVersion) return;
        // A fresh check closes the download/probe gap; recheck input once more in the renderer.
        const fresh = await read();
        if (fresh.fingerprint !== sample.fingerprint || !inWindow(settings, now()) || fresh.pages.some((p) => p.update.status !== "downloaded" || p.update.downloadedVersion !== state.downloadedVersion)) { quiet.reset(); return; }
        const record = { day, version: state.downloadedVersion, at: now().toISOString() };
        await save(record);
        attemptedDay = day;
        if (!inWindow(settings, now())) return;
        status(`installing ${state.downloadedVersion}`);
        await evaluate(ids[0], `async () => { const a=window.__t3Overnight; const s=await window.desktopBridge.getUpdateState(); if (!a || a.inputIdleMs()<${quietMs} || a.hasDraft() || !s.enabled || s.status!=="downloaded" || s.downloadedVersion!==${JSON.stringify(state.downloadedVersion)}) return false; return window.desktopBridge.installUpdate(${JSON.stringify(state.downloadedVersion)}); }`);
      } catch (error) {
        quiet.reset();
        if (error.code !== "ENOENT") status("deferred: activity or update controls could not be verified");
      } finally { pending = false; }
    },
  };
}
