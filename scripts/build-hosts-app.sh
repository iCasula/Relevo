#!/bin/zsh
# Builds «Relevo Hosts.app» (the menu-bar app around the cross-platform desktop app) and installs it in
# ~/Applications. The program it runs (Host/, Node) is installed by Host/deploy/install-mac-desktop.sh, which
# calls this script; the program then updates itself from signed releases, this shell doesn't need to.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
swift build -c release --product RelevoHosts
APP="$ROOT/build/Relevo Hosts.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/.build/release/RelevoHosts" "$APP/Contents/MacOS/RelevoHosts"
if [[ ! -f "$ROOT/build/AppIcon.icns" ]]; then
  swift "$ROOT/scripts/make-icon.swift" "$ROOT/build/AppIcon.iconset"
  iconutil -c icns "$ROOT/build/AppIcon.iconset" -o "$ROOT/build/AppIcon.icns"
fi
cp "$ROOT/build/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
VERSION=$(cat "$ROOT/Host/VERSION")
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Relevo Hosts</string>
  <key>CFBundleDisplayName</key><string>Relevo Hosts</string>
  <key>CFBundleIdentifier</key><string>app.relevo.hosts</string>
  <key>CFBundleExecutable</key><string>RelevoHosts</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
IDENTITY=${RELEVO_SIGN_IDENTITY:-$(head -1 "$ROOT/.signing-identity" 2>/dev/null || true)}
if [[ -n "$IDENTITY" && ! "$IDENTITY" =~ ^[0-9A-F]{40}$ ]]; then
  IDENTITY=$(security find-identity -v -p codesigning | grep -F "\"$IDENTITY\"" | tail -1 | awk '{print $2}')
fi
if [[ -n "$IDENTITY" ]] && codesign --force --deep --sign "$IDENTITY" "$APP" 2>/dev/null; then echo "Firmado con una identidad estable"
else codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true; fi
mkdir -p "$HOME/Applications"
pkill -x RelevoHosts 2>/dev/null || true
rm -rf "$HOME/Applications/Relevo Hosts.app"
cp -R "$APP" "$HOME/Applications/Relevo Hosts.app"
echo "Instalado en ~/Applications/Relevo Hosts.app"
