#!/bin/zsh
# Builds "~/Applications/T3 Code Add-ons.app", a launcher that runs launch.sh from this checkout.
set -eu
DIR=${0:A:h}
APP_SRC="/Applications/T3 Code (Nightly).app"
OUT="$HOME/Applications/T3 Code Add-ons.app"
mkdir -p "$HOME/Applications"
rm -rf "$OUT"
osacompile -o "$OUT" -e "do shell script quoted form of \"$DIR/launch.sh\""
if [[ -d $APP_SRC ]]; then
  ICON=$(plutil -extract CFBundleIconFile raw "$APP_SRC/Contents/Info.plist")
  cp "$APP_SRC/Contents/Resources/${ICON%.icns}.icns" "$OUT/Contents/Resources/applet.icns"
  touch "$OUT"
fi
# Preserve shortcuts to the old name, but only migrate our own launcher.
LEGACY="$HOME/Applications/T3 Code Ctrl-Tab.app"
if [[ -d "$LEGACY" && ! -L "$LEGACY" ]]; then
  LEGACY_SCRIPT=$(osadecompile "$LEGACY/Contents/Resources/Scripts/main.scpt" 2>/dev/null || true)
  if [[ "$LEGACY_SCRIPT" == *"$DIR/launch.sh"* ]]; then
    BACKUPS="$HOME/Library/Application Support/t3code-addons/launcher-backups"
    mkdir -p "$BACKUPS"
    mv "$LEGACY" "$BACKUPS/T3 Code Ctrl-Tab.$(date +%Y%m%d%H%M%S).$$.app"
    ln -s "$OUT" "$LEGACY"
  fi
fi
echo "Installed $OUT"
