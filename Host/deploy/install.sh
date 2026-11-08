#!/bin/sh
# Installs or updates relevo-host on a Linux machine over ssh, as a systemd user service (needs lingering
# enabled for that user so it runs without a login: `loginctl show-user $USER -p Linger`).
#
#   Host/deploy/install.sh <user@host> <base folder> <projects folder> [name]
#
# <base folder>/app       the program (a few files)
# <base folder>/data      state, transcripts, Claude Code config, temp files and caches of the agents
# <base folder>/host.env  settings (written once; edit it and restart the service to change them)
# <base folder>/relevo-host   wrapper: `relevo-host pair | login | status`
set -eu
[ $# -ge 3 ] || { echo "usage: $0 <user@host> <base folder> <projects folder> [name]" >&2; exit 2; }
TARGET=$1 BASE=$2 PROJECTS=$3 NAME=${4:-}
HERE=$(cd "$(dirname "$0")/.." && pwd)

ssh "$TARGET" "mkdir -p '$BASE/app' '$BASE/data' '$PROJECTS'"
rsync -a --delete --exclude '._*' --exclude '.DS_Store' "$HERE/relevo-host.mjs" "$HERE/lib" "$TARGET:$BASE/app/"

ssh "$TARGET" sh -s -- "$BASE" "$PROJECTS" "$NAME" <<'REMOTE'
set -eu
BASE=$1 PROJECTS=$2 NAME=${3:-$(hostname)}
NODE=$(command -v node) || { echo "node not found" >&2; exit 1; }
if [ ! -f "$BASE/host.env" ]; then
  cat > "$BASE/host.env" <<EOF
RELEVO_HOST_DATA=$BASE/data
RELEVO_PROJECTS=$PROJECTS
RELEVO_HOST_NAME=$NAME
RELEVO_PORT=47820
RELEVO_MAX_AGENTS=2
RELEVO_MIN_FREE_GB_DATA=1
RELEVO_MIN_FREE_GB_PROJECTS=2
EOF
fi
cat > "$BASE/relevo-host" <<EOF
#!/bin/sh
set -a; . "$BASE/host.env"; set +a
exec "$NODE" "$BASE/app/relevo-host.mjs" "\$@"
EOF
chmod +x "$BASE/relevo-host"
# `relevo-host pair|login|status` from any shell (a link, nothing else on the system disk).
mkdir -p "$HOME/.local/bin" && ln -sf "$BASE/relevo-host" "$HOME/.local/bin/relevo-host"

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/relevo-host.service" <<EOF
[Unit]
Description=Relevo host for Relevo Companion
After=network-online.target

[Service]
ExecStart=$BASE/relevo-host serve
Restart=on-failure
RestartSec=5
Nice=5
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable relevo-host.service >/dev/null 2>&1
systemctl --user restart relevo-host.service
sleep 2
systemctl --user --no-pager --lines=5 status relevo-host.service | sed -n '1,12p'
echo
echo "Pairing link (open it on the iPhone, or paste it in Relevo Companion):"
"$BASE/relevo-host" pair
REMOTE
