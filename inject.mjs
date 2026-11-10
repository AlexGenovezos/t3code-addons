#!/usr/bin/env node
// Injects switcher.js into every T3 Code window over the Chrome DevTools Protocol.
// Stays connected (injected scripts live as long as the CDP session) and exits when the app quits.
import { readFileSync } from "node:fs";
import { createQuotaBridge } from "./quota-bridge.mjs";

const PORT = Number(process.env.T3_CDP_PORT ?? 9333);
const source = ["switcher.js", "quota-panel.js"].map((file) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8")).join("\n");
const isAppPage = (info) => info.type === "page" && info.url.startsWith("t3code:");

async function browserWsUrl() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`No CDP endpoint on 127.0.0.1:${PORT}; was the app launched with the port?`);
}

const ws = new WebSocket(await browserWsUrl());
let nextId = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id, method, params, sessionId })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });

const bridge = createQuotaBridge(send);
const injected = new Map();
async function inject(info) {
  if (!isAppPage(info) || injected.has(info.targetId)) return;
  injected.set(info.targetId, null);
  try {
    const { sessionId } = await send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
    injected.set(info.targetId, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Runtime.addBinding", { name: "__t3QuotaRequest" }, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
    const result = await send("Runtime.evaluate", { expression: source }, sessionId);
    if (result.exceptionDetails) throw new Error("Add-on script failed");
    console.log(`injected into ${info.url}`);
  } catch (error) {
    injected.delete(info.targetId);
    console.error(`inject failed for ${info.url}: ${error.message}`);
  }
}

ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p?.timer);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
    return;
  }
  void bridge.event(msg).catch(() => {});
  if (msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") {
    void inject(msg.params.targetInfo);
  } else if (msg.method === "Target.targetDestroyed") {
    bridge.forget(injected.get(msg.params.targetId));
    injected.delete(msg.params.targetId);
  }
});
ws.addEventListener("close", () => process.exit(0));
ws.addEventListener("error", () => process.exit(1));
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

await send("Target.setDiscoverTargets", { discover: true });
const { targetInfos } = await send("Target.getTargets");
await Promise.all(targetInfos.map(inject));
