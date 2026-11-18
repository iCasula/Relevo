#!/bin/sh
# The Relevo desktop app on a Mac, alone: a window to manage the agents of Relevo hosts on other machines (your
# Windows PC, a server…), the same window as on Windows. No agents run on the Mac through it; the native Relevo
# app keeps doing that, and can be paired in this window too (its Ajustes › iPhone link).
#
#   Host/deploy/install-mac-desktop.sh
#
# Puts the program in ~/Library/Application Support/Relevo Desktop/app (updated from the window: Ajustes ›
# Integraciones) and «Relevo Hosts.app» in ~/Applications. Needs Node 22+ and, for a window of its own, Chrome,
# Edge, Brave or Chromium (otherwise it opens in your browser).
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
BASE="$HOME/Library/Application Support/Relevo Desktop"
APP="$HOME/Applications/Relevo Hosts.app"
NODE=$(command -v node) || { echo "Node not found: install Node 22 or newer first." >&2; exit 1; }
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node 22 or newer is needed ($("$NODE" --version))." >&2; exit 1; }

mkdir -p "$BASE/app"
rsync -a --delete --exclude '._*' --exclude '.DS_Store' "$HERE/relevo-host.mjs" "$HERE/lib" "$HERE/ui" "$HERE/VERSION" "$BASE/app/"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/MacOS/relevo-hosts" <<SCRIPT
#!/bin/sh
exec "$NODE" "$BASE/app/relevo-host.mjs" desktop
SCRIPT
chmod +x "$APP/Contents/MacOS/relevo-hosts"
ICON=""
for f in /Applications/Relevo.app/Contents/Resources/*.icns "$HOME/Applications/Relevo.app/Contents/Resources/"*.icns; do
  [ -f "$f" ] && { cp "$f" "$APP/Contents/Resources/AppIcon.icns"; ICON="<key>CFBundleIconFile</key><string>AppIcon</string>"; break; }
done
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>relevo-hosts</string>
  <key>CFBundleIdentifier</key><string>app.relevo.hosts</string>
  <key>CFBundleName</key><string>Relevo Hosts</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(cat "$HERE/VERSION")</string>
  <key>LSUIElement</key><true/>
  $ICON
</dict></plist>
PLIST
echo "Installed: $APP"
echo "Open it, and paste the pairing link of your Windows PC (there: Relevo › Ajustes › iPhone › Copiar enlace)."
open "$APP"
