#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const port = Number(process.env.T3_CDP_PORT ?? 9333);
let stopped = false;
let child;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopped = true; child?.kill(signal); });
while (!stopped) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (response.ok && !stopped) {
      child = spawn(process.execPath, [fileURLToPath(new URL("./inject.mjs", import.meta.url))], { stdio: "inherit" });
      await once(child, "exit");
      child = undefined;
    }
  } catch {}
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
}
