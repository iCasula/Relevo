# Relevo host (headless)

A proof of concept: Relevo's iPhone app driving agents on a machine other than the Mac, such as a Linux mini PC
that stays on when the Mac is off, or a Windows PC. It speaks the same protocol as the Mac app (TLS-PSK + WebSocket + the
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

- When a turn runs out of quota, the thread follows its plan (or the host's): ask, move to the subscription
  with most quota left, a given one, or wait for the reset and carry on — with a countdown that can be cut
  short or cancelled, like the Mac's automatic relay. A handoff carries the transcript and the project's git
  state (branch, uncommitted changes, last commits).
- Projects: the subfolders of the projects folder (changeable from the apps) plus folders added from
  anywhere; created and removed from the apps. Threads can be renamed and deleted, and get a title from a
  cheap model after their first turn.
- Git per thread (changes, diffs, commit, commit and push, a commit message written by a model), images the
  thread mentions, token and cost statistics, older history on demand, and signing in to each agent from the
  apps.

Not yet: other providers (Gemini, Kimi…), several accounts per provider, worktrees, «Relevo sugiere», Live
Activity push with the app closed and publishing Bonjour (the iPhone connects through the addresses in the
pairing link, which also works through a VPN).

## Requirements

Node 22 or newer (20 on Windows), the `claude` and/or `codex` CLIs, and on Linux a user with systemd lingering
(`loginctl show-user $USER -p Linger`) so the service runs without a login. No `npm install`: the program is a
few files with no dependencies.

## Install or update (Linux)

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

## Install or update (Windows)

The simplest way: download **`Instalar-Relevo.cmd`** from the repository's latest
[release](https://github.com/iCasula/Relevo/releases/latest) and open it. It asks for administrator rights,
offers to install Node.js with winget if it's missing, downloads the newest release and runs the installer
below (asking for your projects folder the first time). SmartScreen may warn about a downloaded script: «Más
información» › «Ejecutar de todas formas».

By hand, from an **administrator** PowerShell, signed in as the user whose logins and projects the agents will use, in a
copy of this repository on the PC:

```powershell
powershell -ExecutionPolicy Bypass -File Host\deploy\install-windows.ps1 [-Projects C:\path\to\projects] [-Base <folder>] [-Name <name>]
```

- `<Base>` defaults to `%LOCALAPPDATA%\RelevoHost`, with the same `app`, `data` and `host.env` as on Linux, and
  `relevo-host.cmd` (the folder goes in your PATH). Projects default to `%USERPROFILE%\Projects`.
- A scheduled task **Relevo host** starts it with Windows, before anyone signs in, as you (S4U: no stored
  password, no window). `serve` supervises its own worker: it restarts it after `update` or a crash and writes
  its output to `<data>\logs\host.log`. `TEMP`/`TMP` also point at the data folder.
- A firewall rule opens the port (47820) on private and domain networks. If Windows calls your network
  *Public*, change it to private or the iPhone won't get through.
- `host.env` gets the absolute paths of `claude`, `codex` and Git Bash (`CLAUDE_CODE_GIT_BASH_PATH`; Claude Code
  runs its commands with it, so install Git for Windows). Codex from npm (`codex.cmd`) works: the host runs
  the npm package's script with Node instead of the batch file.
- Running the script again updates the program and keeps `host.env`; `-Uninstall` removes the task, the rule
  and the PATH entry (the data stays).
- The PC must not go to sleep while you want to reach it (Settings › System › Power).
- **Relevo** shortcuts in the Start menu and on the desktop open the desktop app (below).

Then, in a new terminal: `relevo-host login claude`, `relevo-host login codex`, `relevo-host pair`,
`relevo-host status`, `relevo-host update`, `relevo-host logs`, as on Linux.

After a login the running service checks the accounts again, so the iPhone shows the session straight away
(it also does when the iPhone connects, for any account signed out or not checked in the last two minutes).
`login` and `update` reach the service through files in `<data>/control`, which it checks every 2 s, so they
work the same with systemd and on Windows.

## Desktop app

With `RELEVO_UI_PORT` set (the Windows installer sets 47821), the service also serves a desktop app: every
paired host in one window — this PC, the Mac, a mini PC — with their projects and threads, the conversation
(Markdown, tools, permission requests and the agents' questions), the composer (subscription and model,
reasoning, permission mode, what to do when the quota runs out, queue, stop and «send now»), relays, Relevo's
suggestions, limits of every account, and Windows notifications when a thread finishes or needs you. Also:
thread search; projects added from any folder (a folder browser over the host's disks) or created, and
removed; the projects folder, default subscription and permissions, what to do when the quota runs out, how
many agents at once and AI titles, in Ajustes; signing in to each agent (the link to open and the code to
paste, no terminal); «Cambios» with each file's diff, commit and push and a message written with AI;
«Consumo» per thread and per period, model and thread; images the agents mention; older history; several
agents on the same task at once (Comparar agentes); «Abrir en VS Code» for this PC's projects.

- How it's built: the page (`ui/`, plain HTML, CSS and JavaScript modules, no build step) talks only to this
  service on 127.0.0.1 (`lib/ui-server.mjs`). The service connects to every paired host as the iPhone does,
  with the same TLS-PSK protocol (`lib/remote.mjs`, `connectCompanion` in `lib/transport.mjs`), this one
  included. `ui/state.mjs` (pairing links, messages, applying patches) is shared by the page and the
  service. So the engine, the protocol and the client are the same code on Linux and Windows, and the page
  opens in any browser.
- Only this machine reaches the page, and only through the link with the token (`<data>/desktop/ui-token`):
  the first visit trades it for a cookie bound to 127.0.0.1, and the WebSocket also checks the origin.
- `relevo-host app` opens it as an app window (Edge or Chrome with `--app`); `relevo-host app --url`
  prints the link. Paired hosts are kept in `<data>/desktop/hosts.json`; add one in Hosts by pasting its
  pairing link (the Mac's from Settings › iPhone, a server's from `relevo-host pair`).

## Updates and releases

Installed hosts update from the repository's **release tags** (`vX.Y.Z`); `<app>/VERSION` says which one
is installed.

- Only **signed** releases are offered and installed: each release has `relevo-host-<tag>.tar.gz`,
  `manifest.json` (the SHA-256 of the archive and of every file) and `manifest.sig`, an ed25519 signature of
  the manifest. The public key is in `lib/updater.mjs`; the private one never leaves the publisher's machine
  (`~/.relevo/release-signing.pem`). Every file is checked before anything is replaced.
- The version being replaced is kept in `<app>.prev`. If the new one keeps dying at start, the supervisor puts
  the previous one back on its own; `relevo-host rollback` does it by hand.
- The desktop app checks at start and every 6 hours, shows «Nueva versión» in the sidebar, and installs it
  from Hosts › Actualizaciones; the service restarts and the window reloads itself.
- `relevo-host update --check` says whether there's a newer tag; `relevo-host update` installs the newest
  one (or `main` when there are no tags); `relevo-host update v1.2.3` or `relevo-host update main` install
  that one.
- Only `relevo-host.mjs`, `lib/`, `ui/` and `VERSION` are downloaded, into the program's folder, with no git
  or `tar` needed; each file replaces the old one only once downloaded.
- To publish a version: bump `Host/VERSION`, commit, push a tag (`git tag v1.2.3 && git push origin v1.2.3`),
  wait for the `Release` workflow (tests, then the release with the archive, the manifest,
  `Instalar-Relevo.cmd` and a zip of `Host/`), and sign it: `node Host/deploy/release.mjs sign v1.2.3`. That
  checks the published files against your local tag before signing and uploads `manifest.sig`; until then
  installed hosts don't see the release.

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

`node --test 'Host/test/*.test.mjs'` runs the unit tests and an end-to-end run of the whole host with the echo
agent over TLS-PSK (a turn, a permission, a relay when the quota runs out, the apps' requests, the desktop
page's protection). CI runs it on Linux and Windows (`.github/workflows/test.yml`).

`RELEVO_FAKE_AGENT=1` replaces the agents with an echo agent that also asks for a permission when the message says
"permiso", asks a question when it starts with "pregunta" and runs out of quota when it starts with "agota la
cuota". From the Mac, `Relevo --selftest remotehost "<pairing link>" ["prompt"] [ask|autoEdit|full|plan]`
connects like the iPhone, checks that every message decodes and, with a prompt, runs a turn end to end;
add `relay` to then hand the thread to the other subscription and check it carries on. `RELEVO_SUPERVISE=1`
runs the Windows supervisor on any system.
