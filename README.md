# T3 Code Add-ons

A VS Code–style most-recently-used thread switcher and optional CLIProxy quota panel for the [T3 Code](https://github.com/pingdotgg/t3code) desktop app (macOS, Nightly).

- Hold **Ctrl** and tap **Tab** to walk back through recently opened threads (**Ctrl+Shift+Tab** goes the other way).
- Let go of **Ctrl** to open the highlighted thread.
- **Escape** or switching away from the window cancels.

Rows show the project's favicon, the thread title and the project name.

Settled threads are left out: only threads above the sidebar's **Settled** shelf are offered. If you unsettle one, it comes back.

The add-on includes:

- **Ctrl-Tab thread switching:** jump between recently opened active threads.
- **CLIProxy quotas:** account tiers, remaining usage, reset times, and pooled totals weighted where plan allowances are known.
- **Claude proxy limit reporting:** confirmed pool-reset times for new Claude CLIProxy sessions.
- **Automatic reconnection:** reattach after T3 restarts with its debugging port.
- **Overnight desktop updates:** optionally install official T3 updates during a quiet 3–6 a.m. window.

This is an unofficial add-on. It does not modify the app: the official build keeps auto-updating as normal.

## How it works

1. `launch.sh` starts `T3 Code (Nightly)` with `--remote-debugging-port=9333`, Chromium's standard DevTools port. The port listens on localhost only.
2. `watch.mjs` waits for the debugging endpoint and reconnects after restarts. `inject.mjs` connects to that port over the Chrome DevTools Protocol. It adds the switcher, quota panel, and activity tracker to every T3 Code window, including new windows and reloads. The injector exits when the app quits; the watcher waits for it to return.
3. `switcher.js` is plain page JavaScript. It:
   - records which threads you open
   - reads titles and icons from the sidebar
   - draws its own overlay
   - switches threads by changing the page's URL hash

   It doesn't use any of the app's internals.

## Install

Requires macOS, Node.js 22+ (for the built-in `WebSocket`), and `T3 Code (Nightly)` in `/Applications`.

```sh
git clone https://github.com/AlexGenovezos/t3code-addons.git
cd t3code-addons
./install.sh
```

This builds `~/Applications/T3 Code Add-ons.app`, a launcher that runs `launch.sh` from your clone.

### Updating an existing installation

The project was previously named **T3 Code Ctrl-Tab** (`t3code-ctrl-tab`). GitHub redirects the old repository URL. Keep your existing checkout directory in place, especially if the Claude companion is installed, then run these commands from it:

```sh
git remote set-url origin https://github.com/AlexGenovezos/t3code-addons.git
git pull --ff-only
./install.sh
```

The installer replaces a recognized old launcher from this checkout with a compatibility link to **T3 Code Add-ons**, preserving its original under `~/Library/Application Support/t3code-addons/launcher-backups/`. Existing shortcuts to that path still work. Updating the launcher does not restart T3 or running agents.

## Use

1. Quit T3 Code. Quitting stops its bundled server and any running agents.
2. Open **T3 Code Add-ons** instead of the regular icon.
3. Open a couple of threads. The switcher only knows threads you've opened since installing it.

If T3 Code is already running without the debug port, the launcher shows an alert instead of quitting it for you.

The injector logs to `~/Library/Logs/t3code-addons.log`. Set `T3_CDP_PORT` to use a different port.

## Caveats

- **Restarts need the debugging port.** The watcher reconnects automatically when T3 restarts with the port. If an update or normal launch drops the flag, quit T3 when your agents are finished and reopen through the launcher. The launcher never quits T3 for you; explicitly enabling overnight updates authorizes an idle restart inside its configured window.
- **Local programs can control the app.** While the debugging port is open, any process on your Mac can drive the app through it. It isn't reachable from the network.
- **Only threads in the sidebar appear.** The switcher reads the sidebar for titles and icons and for which threads are still active, so settled, archived and deleted threads drop out automatically.
- **App updates can break it.** It depends on T3 Code's sidebar markup (`li[data-thread-item]`, the `sidebar-settled-header` shelf) and hash routes (`#/<environmentId>/<threadId>`). If the app changes those, the switcher will need updating.

## Optional CLIProxy quotas

Open the same **T3 Code Add-ons** launcher, then click **CLIProxy** at the bottom right. The separate panel shows account tier labels, shared five-hour and weekly quotas, model-scoped weekly limits, and reset times. It refreshes each minute while open.

Create `quota-config.json` next to `launch.sh` (gitignored; use permissions `0600`):

```json
{
  "url": "http://127.0.0.1:8317",
  "managementKey": "YOUR_CLIPROXY_MANAGEMENT_KEY"
}
```

Use your proxy's reachable address on a remote Mac. The management key remains in the Node helper and is never injected into T3's page. Only account names, plans, usage and reset metadata are sent to the panel. Use a trusted private connection to the proxy.

Claude shared five-hour capacity is weighted Pro = 1, Max 5× = 5, Max 20× = 20, Team Standard = 1.25, Team Premium = 6.25 (Anthropic's [published per-session multiples](https://support.claude.com/en/articles/9266767-what-is-the-team-plan); Team seats are read from the profile's seat tier). Weekly Claude allowances and unknown ratios (Business Premium, Enterprise) are not assumed to follow those multipliers: the panel explicitly shows an account average when a pool includes an unknown ratio. Known Codex Plus/Pro ratios use estimates from the upstream weighting proposal; Standard Business counts as Plus, matching OpenAI's [published limits](https://learn.chatgpt.com/docs/pricing). Pooled five-hour totals account for a spent shared weekly quota; model-specific headroom is shown separately. Partial reads are marked.

### Claude limit reporting companion

With quota config present, the launcher installs a reversible wrapper around `~/.local/bin/claude-cliproxy`. For remote provider sessions, install the repo and private config on that host too, then run:

```sh
node install-relay.mjs
```

New Claude proxy sessions use it; existing provider processes are unaffected. Normal commands and streams pass through. On a terminal HTTP 429, it spends at most five seconds checking fresh, model-eligible account quotas. Only when the whole eligible pool is confirmed exhausted does it add a native rejected rate-limit event and a reset suffix for T3. Model-scoped exhaustion adds the suffix alone, preserving the shared weekly reading. Existing native reset information takes precedence. Unknown routes, failed readings, enabled overage, unknown exhausted scopes or remaining capacity prevent a guessed reset. This reports confirmed quota resets; it cannot diagnose every proxy 429 or guarantee automatic resumption in every T3 release. Codex quotas appear in the panel, but this companion only handles Claude native limit events.

The original executable is backed up privately under `.relay-originals/`. Restore it with:

```sh
node install-relay.mjs --uninstall
```

To stop UI injection, terminate only the helper identified by `.inject.pid` after checking its command, then reload T3. Remove `quota-config.json` to prevent automatic relay installation on the next launcher run. Keep the checkout in place while the companion is installed.

This builds on the tier, weighting and pool-recovery approaches proposed in upstream T3 PRs [#19982](https://github.com/pingdotgg/t3code/pull/19982), [#13675](https://github.com/pingdotgg/t3code/pull/13675) and [#27214](https://github.com/pingdotgg/t3code/pull/27214). It does not patch stock T3's Usage page or app bundle.

## Overnight desktop updates

Copy `overnight-config.example.json` to `overnight-config.json` (gitignored), change the probe paths and SSH host to your installation, then launch **T3 Code Add-ons**. With no config this feature is off. Set `enabled` to `false` to pause it; config changes take effect on the next one-minute poll.

The default window is **3:00–6:00 a.m. in the Mac's local timezone**, with at least ten continuously observed quiet minutes. Only the official T3 desktop app is updated; linked servers, providers, and this add-on are not automatically upgraded.

Before checking/downloading a release and again before installing it, the helper requires:

- No active or queued runs, provider turns, pending approvals/questions, subagents, background commands/tasks, or unfinished orchestration effects on any checked host.
- Every enabled environment in T3's saved connection catalog and its local backends covered by a fresh, explicitly idle probe. A new or unreachable environment blocks the update until its probe is configured or the environment is disabled in T3.
- No recent keyboard/mouse activity on the Mac, no recent input in any T3 window, and no nonempty composer currently rendered in those windows.
- No activity revision change during the quiet period, and no automation due in the next ten minutes. Sleep or a long polling gap starts the quiet period again.

`activity-probe.py` reads T3's V2 SQLite database **read-only** with a short query deadline, returning only environment ID, idle status, and event revision. It uses an upstream partial index to avoid scanning historical tool payloads. Missing files, an unsupported schema, or failed probes defer the update. Python 3 is required on each host. The optional argument is an absolute state directory (default `~/.t3/userdata`). SSH must already authenticate noninteractively and have a verified host key; never put passwords in the config.

T3's normal desktop bridge checks, downloads, and installs the prepared release. The helper honors the selected update channel and attempts at most one installation per local calendar day, recording it in `.overnight-state.json`. It never forces an update or suppresses T3's policies. The activity check and install are separate operations in stock T3, so they cannot form an atomic lock against a new remote run starting at the last instant.

The Mac must be awake and T3 running through the add-on launcher with its debugging port. This feature does not wake the Mac or reopen an app you closed. The watcher reconnects after an update if the port survives; if T3's updater drops the flag, reopen through **T3 Code Add-ons** when your agents are finished. No force-quit fallback is used. Decisions appear in `~/Library/Logs/t3code-addons.log`.

## Test

Quota, stream forwarding, shutdown, timeout and origin-isolation tests use only Node:

```sh
node --test test/*.test.mjs
python3 -m unittest discover -s test -p '*_test.py'
```

`test/run.sh` loads the switcher into a mock T3 Code window in a throwaway Electron app. It then drives the keyboard over CDP and checks:

- recent-thread order
- cycling in both directions
- opening the thread on Ctrl release
- Escape cancelling
- surviving a reload

```sh
test/run.sh                      # uses `npx electron`
ELECTRON=/path/to/Electron test/run.sh
```

## Built-in version

`upstream/ctrl-tab-switcher.patch` is the same feature built into T3 Code itself, written against upstream `main`. It's kept here in case the feature is accepted upstream. See the [ideas discussion](https://github.com/pingdotgg/t3code/discussions/9751).

## License

MIT
