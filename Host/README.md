# Relevo host (headless)

A proof of concept: Relevo's iPhone app driving agents on a machine without a screen, such as a Linux mini PC
that stays on when the Mac is off. It speaks the same protocol as the Mac app (TLS-PSK + WebSocket + the
`RelevoProtocol` messages), so the iPhone pairs with it like with a Mac and switches between hosts.

What it does today:

- Projects are the subfolders of one folder (`RELEVO_PROJECTS`).
- Threads run **Claude Code** with its own login (`claude -p` with stream-json and permission prompts over
  stdio, like the Mac's `ClaudeAgent`): streaming replies, tools, permission requests and the agent's
  questions, message queue, stop and "send now", model, reasoning and permission mode, limits, and turn usage.
- One process per thread stays alive between turns and closes after 15 idle minutes (the next message
  resumes the same session). `RELEVO_MAX_AGENTS` caps how many run at once.
- Live Activity state goes over the connection while the iPhone app is open.

Not yet: other providers (Codex, Gemini…), handoffs between subscriptions, images, Live Activity push with the
app closed, publishing Bonjour (the iPhone connects through the addresses in the pairing link, which also
works through a VPN) and creating projects from the phone.

## Requirements

Node 22 or newer, the `claude` CLI, and a user with systemd lingering (`loginctl show-user $USER -p Linger`)
so the service runs without a login. No `npm install`: the program is four files with no dependencies.

## Install or update

From the Mac, over ssh:

```sh
Host/deploy/install.sh user@server /path/on/a/data/disk/relevo-host /path/to/projects [name]
```

- `<base>/app`: the program. `<base>/data`: state, transcripts, Claude Code's config, temp files and the
  agents' tool caches (`CLAUDE_CONFIG_DIR`, `TMPDIR`, `XDG_CACHE_HOME`, npm/uv/pip caches all point here), so
  nothing grows on the system disk. Claude Code's auto-updater is off.
- `<base>/host.env`: settings, written once (edit and `systemctl --user restart relevo-host`).
- A systemd user service `relevo-host`, and `~/.local/bin/relevo-host` for the commands below.

Then on the server:

```sh
relevo-host login    # Claude Code sign-in for this host (its own config folder)
relevo-host pair     # pairing link: open it on the iPhone, paste it in the app, or turn it into a QR code
relevo-host status   # login, plan, limits and models, without calling a model
journalctl --user -u relevo-host -f
```

## Disk

- A turn doesn't start when the data folder has less than `RELEVO_MIN_FREE_GB_DATA` (1 GB) free or the
  project's disk less than `RELEVO_MIN_FREE_GB_PROJECTS` (2 GB); the thread says why.
- Transcripts keep the newest 1,500 items per thread; Claude Code prunes its own after 14 days
  (`cleanupPeriodDays` in the host's Claude settings); temp files older than a day are removed.
- Projects on exFAT work, with its limits: no symlinks (use `npm install --no-bin-links`), no Unix
  permissions; git detects both by itself.

## Testing

`RELEVO_FAKE_AGENT=1` replaces Claude with an echo agent that also asks for a permission when the message says
"permiso". From the Mac, `Relevo --selftest remotehost "<pairing link>" ["prompt"] [ask|autoEdit|full|plan]`
connects like the iPhone, checks that every message decodes and, with a prompt, runs a turn end to end.
