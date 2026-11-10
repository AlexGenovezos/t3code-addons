#!/bin/zsh
# Starts T3 Code (Nightly) with a localhost CDP port and injects the Ctrl+Tab switcher.
# If Nightly is already running with the port, only (re)injects; without it, refuses rather
# than quitting the app (that would stop its server and any running agents).
set -eu
DIR=${0:A:h}
APP="T3 Code (Nightly)"
PORT=${T3_CDP_PORT:-9333}
LOG="$HOME/Library/Logs/t3-ctrl-tab.log"
NODE=$(command -v node || echo /opt/homebrew/bin/node)

if [[ -f "$DIR/quota-config.json" ]]; then
  "$NODE" "$DIR/install-relay.mjs" >>"$LOG" 2>&1
fi

if ! curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null; then
  if [[ $(osascript -e "application \"$APP\" is running") == true ]]; then
    osascript -e "display alert \"$APP is already running without the Ctrl+Tab debug port.\" message \"Quit it (this stops running agents), then open this launcher again.\""
    exit 1
  fi
  open -a "$APP" --args --remote-debugging-port="$PORT"
fi

PIDFILE="$DIR/.inject.pid"
if [[ -f $PIDFILE ]]; then
  OLD_PID=$(cat "$PIDFILE")
  if [[ "$OLD_PID" == <-> ]]; then
    OLD_COMMAND=$(ps -p "$OLD_PID" -o command= 2>/dev/null || true)
    if [[ "$OLD_COMMAND" == *"$DIR/watch.mjs"* || "$OLD_COMMAND" == *"$DIR/inject.mjs"* ]]; then
      kill "$OLD_PID" 2>/dev/null || true
    fi
  fi
fi
T3_CDP_PORT=$PORT nohup "$NODE" "$DIR/watch.mjs" >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
