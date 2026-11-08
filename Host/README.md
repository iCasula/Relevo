# Relevo host (headless)

A proof of concept: Relevo's iPhone app driving agents on a machine without a screen, such as a Linux mini PC
that stays on when the Mac is off. It speaks the same protocol as the Mac app (TLS-PSK + WebSocket + the
`RelevoProtocol` messages), so the iPhone pairs with it like with a Mac and switches between hosts.

What it does today:

- Projects are the subfolders of one folder (`RELEVO_PROJECTS`).
- Threads run **Claude Code** (`claude -p` with stream-json and permission prompts over stdio, like the Mac's
  `ClaudeAgent`) or **Codex** (`codex app-server`, like `CodexAgent`), each with its own login on the server:
  streaming replies, tools, permission requests and the agent's questions, message queue, stop and "send now",
  model, reasoning and permission mode, limits, and turn usage.
- Switching a thread to the other subscription (from the composer, or "relevar" when a limit is hit) starts the
  new agent with the thread's transcript as context, like the Mac's handoff.
- One process per thread stays alive between turns and closes after 15 idle minutes (the next message
  resumes the same session). `RELEVO_MAX_AGENTS` caps how many run at once.
- Live Activity state goes over the connection while the iPhone app is open.

Not yet: other providers (Gemini, Kimi…), automatic relays, images, Live Activity push with the app closed, publishing Bonjour (the iPhone connects through the addresses in the pairing link, which also
works through a VPN) and creating projects from the phone.

## Requirements

Node 22 or newer, the `claude` and/or `codex` CLIs, and a user with systemd lingering (`loginctl show-user $USER -p Linger`)
so the service runs without a login. No `npm install`: the program is a few files with no dependencies.

## Install or update

Once, from a computer with this repository (over ssh); after that the server updates itself with
`relevo-host update`, and the iPhone talks to it directly:

```sh
Host/deploy/install.sh user@server /path/on/a/data/disk/relevo-host /path/to/projects [name]
```

- `<base>/app`: the program. `<base>/data`: state, transcripts, Claude Code's config, Codex's home, temp files
  and the agents' tool caches (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `TMPDIR`, `XDG_CACHE_HOME`, npm/uv/pip caches
  all point here), so nothing grows on the system disk. Claude Code's auto-updater is off.
- `<base>/host.env`: settings, written once (edit and `systemctl --user restart relevo-host`).
- A systemd user service `relevo-host`, and `~/.local/bin/relevo-host` for the commands below.

Then on the server:

```sh
relevo-host login claude   # Claude Code sign-in for this host (its own config folder)
relevo-host login codex    # ChatGPT sign-in for Codex with a device code (no browser needed on the server)
relevo-host pair     # pairing link: open it on the iPhone, paste it in the app, or turn it into a QR code
relevo-host status   # login, plan, limits and models, without calling a model
relevo-host update   # latest Host/ from GitHub (main), then restarts the service
journalctl --user -u relevo-host -f
```

After a login the running service checks the accounts again, so the iPhone shows the session straight away
(it also does when the iPhone connects, for any account signed out or not checked in the last two minutes).

## Disk

- A turn doesn't start when the data folder has less than `RELEVO_MIN_FREE_GB_DATA` (1 GB) free or the
  project's disk less than `RELEVO_MIN_FREE_GB_PROJECTS` (2 GB); the thread says why.
- Transcripts keep the newest 1,500 items per thread; Claude Code prunes its own after 14 days
  (`cleanupPeriodDays` in the host's Claude settings); Codex sessions untouched for 30 days and logs older
  than a week are removed (a thread that old starts a new Codex session with the transcript as context); temp
  files older than a day are removed.
- Projects on exFAT work, with its limits: no symlinks (use `npm install --no-bin-links`), no Unix
  permissions; git detects both by itself.

## Testing

`RELEVO_FAKE_AGENT=1` replaces the agents with an echo agent that also asks for a permission when the message says
"permiso". From the Mac, `Relevo --selftest remotehost "<pairing link>" ["prompt"] [ask|autoEdit|full|plan]`
connects like the iPhone, checks that every message decodes and, with a prompt, runs a turn end to end;
add `relay` to then hand the thread to the other subscription and check it carries on.
