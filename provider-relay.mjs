#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { constants } from "node:os";
import { readConfig, readQuotas, poolRecovery } from "./quota.mjs";

export function claudeResetFrames(message, recovery, now = Date.now()) {
  if (message.type !== "result" || !message.is_error || message.api_error_status !== 429 || !recovery || recovery.resetAt <= now || /\(reset after /.test(message.result ?? "")) return [message];
  const seconds = Math.ceil((recovery.resetAt - now) / 1000);
  const result = { ...message, result: `${message.result} (reset after ${seconds}s)` };
  // A scoped limit must not overwrite T3's shared weekly usage window.
  if (recovery.kind === "scoped") return [result];
  return [{
    type: "rate_limit_event", uuid: randomUUID(), session_id: message.session_id,
    rate_limit_info: { status: "rejected", rateLimitType: recovery.kind === "weekly" ? "seven_day" : "five_hour", resetsAt: Math.ceil(recovery.resetAt / 1000), utilization: 1, isUsingOverage: false },
  }, result];
}

export async function relay(command, args, resolveRecovery = async (model, signal) => {
  const snapshot = await readQuotas(await readConfig(), { models: true, signal });
  return poolRecovery(snapshot.accounts, model);
}) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  let spawnError;
  const exit = new Promise((resolve) => {
    const finish = (code, signal) => {
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
      resolve([code, signal]);
    };
    child.once("exit", finish);
    child.once("error", (error) => { spawnError = error; finish(1); });
  });
  const handlers = new Map(["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
  let model = args[args.indexOf("--model") + 1];
  let nativeReset = false;
  if (!args.includes("--model")) model = args.find((arg) => arg.startsWith("--model="))?.slice(8);
  const json = args.some((arg, index) => arg === "--output-format=stream-json" || (arg === "--output-format" && args[index + 1] === "stream-json"));
  if (!json) {
    child.stdout.pipe(process.stdout);
    await once(child.stdout, "end");
  }
  else for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    let messages;
    try {
      const message = JSON.parse(line);
      if (message.type === "system" && message.subtype === "init" && message.model) model = message.model;
      const info = message.rate_limit_info ?? message.api_error_params?.rate_limit_info;
      if (info?.status === "rejected" && info.resetsAt * 1000 > Date.now()) nativeReset = true;
      if (message.type === "result") {
        if (!nativeReset && message.is_error && message.api_error_status === 429 && model) {
          const controller = new AbortController();
          let timer;
          try {
            const recovery = await Promise.race([
              resolveRecovery(model, controller.signal).catch(() => null),
              new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); }),
            ]);
            messages = claudeResetFrames(message, recovery);
          } finally { clearTimeout(timer); controller.abort(); }
        }
        nativeReset = false;
      }
    } catch {}
    for (const output of messages ? messages.map((message) => JSON.stringify(message)) : [line]) {
      if (!process.stdout.write(`${output}\n`)) await once(process.stdout, "drain");
    }
  }
  const [code, signal] = await exit;
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  for (const [name, handler] of handlers) process.off(name, handler);
  if (spawnError) console.error(`Provider could not start: ${spawnError.code ?? "unknown error"}`);
  return code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...args] = process.argv.slice(2);
  process.exitCode = await relay(command, args);
}
