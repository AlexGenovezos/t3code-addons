import { readConfig, readQuotas, publicSnapshot } from "./quota.mjs";

export function createQuotaBridge(send, load = async () => publicSnapshot(await readQuotas(await readConfig()))) {
  const contexts = new Map();
  let snapshot;
  let checkedAt = 0;
  let pending;
  return {
    forget(sessionId) { contexts.delete(sessionId); },
    async event(message) {
      const { method, params, sessionId } = message;
      if (!sessionId) return;
      if (method === "Runtime.executionContextsCleared") contexts.delete(sessionId);
      if (method === "Runtime.executionContextCreated") {
        const context = params.context;
        if (context.origin?.startsWith("t3code:") && context.auxData?.isDefault) {
          if (!contexts.has(sessionId)) contexts.set(sessionId, new Set());
          contexts.get(sessionId).add(context.id);
        }
      }
      if (method === "Runtime.executionContextDestroyed") contexts.get(sessionId)?.delete(params.executionContextId);
      if (method !== "Runtime.bindingCalled" || params.name !== "__t3QuotaRequest" || params.payload !== "read" || !contexts.get(sessionId)?.has(params.executionContextId)) return;
      if (!pending && (!snapshot || Date.now() - checkedAt > 15000)) {
        pending = load().catch(() => ({ error: "CLIProxy usage is unavailable. Check its connection and quota configuration." })).then((result) => {
          snapshot = result;
          checkedAt = Date.now();
          pending = undefined;
          return result;
        });
      }
      const result = pending ? await pending : snapshot;
      if (!contexts.get(sessionId)?.has(params.executionContextId)) return;
      await send("Runtime.evaluate", {
        expression: `window.__t3QuotaReceive?.(${JSON.stringify(result)})`,
        contextId: params.executionContextId,
      }, sessionId);
    },
  };
}
