#!/bin/zsh
# Builds Relevo.app (release) and installs it in ~/Applications.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
CONFIG=${1:-release}
swift build -c "$CONFIG"
BIN="$ROOT/.build/$CONFIG/Relevo"
APP="$ROOT/build/Relevo.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Relevo"

if [[ ! -f "$ROOT/build/AppIcon.icns" ]]; then
  swift "$ROOT/scripts/make-icon.swift" "$ROOT/build/AppIcon.iconset"
  iconutil -c icns "$ROOT/build/AppIcon.iconset" -o "$ROOT/build/AppIcon.icns"
fi
cp "$ROOT/build/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

VERSION=$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Relevo</string>
  <key>CFBundleDisplayName</key><string>Relevo</string>
  <key>CFBundleIdentifier</key><string>app.relevo.mac</string>
  <key>CFBundleExecutable</key><string>Relevo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
</dict>
</plist>
PLIST
# Sign with a stable identity when one is configured (RELEVO_SIGN_IDENTITY or the untracked .signing-identity file):
# the Keychain then recognises every rebuild as the same app, so "Always Allow" is asked only once.
# Without one, ad-hoc signing works but each build looks like a new app to the Keychain.
# The file holds the identity *name* ("Apple Development: Name (ID)"): it survives certificate renewals, and the
# newest valid certificate with that name is used. The Keychain and privacy permissions are tied to that name.
IDENTITY=${RELEVO_SIGN_IDENTITY:-$(head -1 "$ROOT/.signing-identity" 2>/dev/null || true)}
if [[ -n "$IDENTITY" && ! "$IDENTITY" =~ ^[0-9A-F]{40}$ ]]; then
  IDENTITY=$(security find-identity -v -p codesigning | grep -F "\"$IDENTITY\"" | tail -1 | awk '{print $2}')
fi
if [[ -n "$IDENTITY" ]] && codesign --force --deep --sign "$IDENTITY" "$APP" 2>/dev/null; then
  echo "Firmado con una identidad estable"
else
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
  echo "AVISO: firmado ad hoc. El Llavero y macOS volverán a pedir permisos tras cada compilación (ver README › Mac signing)."
fi
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/Relevo.app"
cp -R "$APP" "$HOME/Applications/Relevo.app"
echo "Instalado en ~/Applications/Relevo.app"
