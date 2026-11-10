# T3 Code Ctrl+Tab and CLIProxy quotas

A VS Code–style most-recently-used thread switcher and optional CLIProxy quota panel for the [T3 Code](https://github.com/pingdotgg/t3code) desktop app (macOS, Nightly).

- Hold **Ctrl** and tap **Tab** to walk back through recently opened threads (**Ctrl+Shift+Tab** goes the other way).
- Let go of **Ctrl** to open the highlighted thread.
- **Escape** or switching away from the window cancels.

Rows show the project's favicon, the thread title and the project name.

Settled threads are left out: only threads above the sidebar's **Settled** shelf are offered. If you unsettle one, it comes back.

This is an unofficial add-on. It does not modify the app: the official build keeps auto-updating as normal.

## How it works

1. `launch.sh` starts `T3 Code (Nightly)` with `--remote-debugging-port=9333`, Chromium's standard DevTools port. The port listens on localhost only.
2. `watch.mjs` waits for the debugging endpoint and reconnects after restarts. `inject.mjs` connects to that port over the Chrome DevTools Protocol. It adds `switcher.js` to every T3 Code window, including new windows and reloads. The injector exits when the app quits; the watcher waits for it to return.
3. `switcher.js` is plain page JavaScript. It:
   - records which threads you open
   - reads titles and icons from the sidebar
   - draws its own overlay
   - switches threads by changing the page's URL hash

   It doesn't use any of the app's internals.

## Install

Requires macOS, Node.js 22+ (for the built-in `WebSocket`), and `T3 Code (Nightly)` in `/Applications`.

```sh
git clone https://github.com/AlexGenovezos/t3code-ctrl-tab.git
cd t3code-ctrl-tab
./install.sh
```

This builds `~/Applications/T3 Code Ctrl-Tab.app`, a launcher that runs `launch.sh` from your clone.

## Use

1. Quit T3 Code. Quitting stops its bundled server and any running agents.
2. Open **T3 Code Ctrl-Tab** instead of the regular icon.
3. Open a couple of threads. The switcher only knows threads you've opened since installing it.

If T3 Code is already running without the debug port, the launcher shows an alert instead of quitting it for you.

The injector logs to `~/Library/Logs/t3-ctrl-tab.log`. Set `T3_CDP_PORT` to use a different port.

## Caveats

- **Restarts need the debugging port.** The watcher reconnects automatically when T3 restarts with the port. If an update or normal launch drops the flag, quit T3 when your agents are finished and reopen through the launcher. The add-on never quits T3 for you.
- **Local programs can control the app.** While the debugging port is open, any process on your Mac can drive the app through it. It isn't reachable from the network.
- **Only threads in the sidebar appear.** The switcher reads the sidebar for titles and icons and for which threads are still active, so settled, archived and deleted threads drop out automatically.
- **App updates can break it.** It depends on T3 Code's sidebar markup (`li[data-thread-item]`, the `sidebar-settled-header` shelf) and hash routes (`#/<environmentId>/<threadId>`). If the app changes those, the switcher will need updating.

## Optional CLIProxy quotas

Open the same **T3 Code Ctrl-Tab** launcher, then click **CLIProxy** at the bottom right. The separate panel shows account tier labels, shared five-hour and weekly quotas, model-scoped weekly limits, and reset times. It refreshes each minute while open.

Create `quota-config.json` next to `launch.sh` (gitignored; use permissions `0600`):

```json
{
  "url": "http://127.0.0.1:8317",
  "managementKey": "YOUR_CLIPROXY_MANAGEMENT_KEY"
}
```

Use your proxy's reachable address on a remote Mac. The management key remains in the Node helper and is never injected into T3's page. Only account names, plans, usage and reset metadata are sent to the panel. Use a trusted private connection to the proxy.

Claude shared five-hour capacity is weighted Pro = 1, Max 5× = 5, Max 20× = 20. Weekly Claude allowances and unknown Team/Business ratios are not assumed to follow those multipliers: the panel explicitly shows an account average when a pool includes an unknown ratio. Known Codex Plus/Pro ratios use estimates from the upstream weighting proposal. Pooled five-hour totals account for a spent shared weekly quota; model-specific headroom is shown separately. Partial reads are marked.

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

## Test

Quota, stream forwarding, shutdown, timeout and origin-isolation tests use only Node:

```sh
node --test test/quota.test.mjs test/relay.test.mjs
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
