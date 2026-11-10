#!/usr/bin/env node
import { readFile, writeFile, copyFile, mkdir, chmod, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export async function installRelay({ root = fileURLToPath(new URL(".", import.meta.url)), target = join(homedir(), ".local/bin/claude-cliproxy"), node = process.execPath, uninstall = false } = {}) {
const original = await readFile(target, "utf8");
if (uninstall) {
  if (!original.includes("T3_QUOTA_RELAY")) {
    console.log("No Claude quota relay is installed.");
  } else {
    const backup = original.split("\n").find((line) => line.startsWith("# T3_QUOTA_RELAY; original: "))?.slice(28);
    if (!backup || dirname(backup) !== join(root, ".relay-originals")) throw new Error("Relay backup belongs to a different checkout.");
    const staging = `${target}.quota-${process.pid}`;
    await copyFile(backup, staging);
    await chmod(staging, 0o755);
    await rename(staging, target);
    console.log("Restored original Claude proxy launcher for new sessions.");
  }
} else if (original.includes("T3_QUOTA_RELAY")) {
  if (!original.includes(join(root, "provider-relay.mjs"))) throw new Error("A relay from another checkout is already installed.");
  console.log("Claude quota relay is already installed.");
} else {
  const backups = join(root, ".relay-originals");
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(original).digest("hex").slice(0, 12);
  const backup = join(backups, `claude-cliproxy-${hash}`);
  await copyFile(target, backup);
  await chmod(backup, 0o700);
  const staging = `${target}.quota-${process.pid}`;
  await writeFile(staging, `#!/bin/sh\n# T3_QUOTA_RELAY; original: ${backup}\nexec ${quote(node)} ${quote(join(root, "provider-relay.mjs"))} ${quote(backup)} "$@"\n`, { mode: 0o755 });
  await rename(staging, target);
  console.log("Installed Claude quota relay for new sessions; the original launcher is backed up.");
}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await installRelay({ uninstall: process.argv.includes("--uninstall") });
}
