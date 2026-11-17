// What differs between Linux, macOS and Windows: finding and launching the CLIs, stopping them with the
// processes they start, talking to the running service, and unpacking an update without a `tar` binary.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

export const isWindows = process.platform === 'win32';

/** Extensions tried for a bare name: on Windows the PATHEXT ones (never the extensionless sh script npm also installs). */
function extensions(name) {
  if (!isWindows) return [''];
  if (path.extname(name)) return [''];
  return (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
}

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!isWindows) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** `name` in `dir`, with the platform's executable extensions. */
export function findIn(dir, name) {
  for (const ext of extensions(name)) {
    const p = path.join(dir, name + ext);
    if (isExecutable(p)) return p;
  }
  return null;
}

export function which(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = findIn(dir, name);
    if (p) return p;
  }
  return null;
}

/** The script an npm `.cmd` shim runs (`"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`), or null. */
export function npmShimTarget(shim) {
  let text;
  try { text = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  const m = /"%~?dp0%\\?([^"%]+?\.[cm]?js)"/i.exec(text);
  if (!m) return null;
  const script = path.join(path.dirname(shim), ...m[1].split(/[\\/]/).filter(Boolean));
  return fs.existsSync(script) ? script : null;
}

const CMD_UNSAFE = /[%!^&|<>"\r\n]/;

/**
 * Spawns a CLI. On Windows Node refuses `.cmd`/`.bat` without a shell, so an npm shim runs its script with
 * this Node instead, and any other batch file goes through cmd.exe only with arguments it can't misread.
 */
export function spawnCLI(bin, args, opts = {}) {
  const options = { windowsHide: true, ...opts };
  if (!isWindows || !/\.(cmd|bat)$/i.test(bin)) return spawn(bin, args, options);
  const script = npmShimTarget(bin);
  if (script) return spawn(process.execPath, [script, ...args], options);
  const bad = args.find((a) => CMD_UNSAFE.test(a));
  if (bad !== undefined) throw new Error(`No puedo pasar «${bad}» a ${path.basename(bin)}: configura la ruta al .exe`);
  const line = [bin, ...args].map((a) => `"${a}"`).join(' ');
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true });
}

/** Stops a CLI and whatever it started (on Windows, `kill` would leave Codex's native binary and tool shells running). */
export function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (isWindows && proc.pid) {
    const k = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    k.on('error', () => { try { proc.kill(); } catch {} });
  } else {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

// MARK: - Talking to the running service

/**
 * Commands such as `login` and `update` leave a file in <data>/control; the service checks every 2 s. This
 * replaces signals and systemctl, which don't exist on Windows (and don't need the service's PID).
 */
export function requestControl(dataDir, what) {
  const dir = path.join(dataDir, 'control');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, what), String(Date.now()));
}

export function watchControl(dataDir, handlers) {
  const dir = path.join(dataDir, 'control');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(handlers)) fs.rmSync(path.join(dir, name), { force: true }); // stale requests
  const timer = setInterval(() => {
    for (const [name, handler] of Object.entries(handlers)) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      fs.rmSync(p, { force: true });
      handler();
    }
  }, 2000);
  timer.unref();
  return timer;
}

// MARK: - Settings file

/** KEY=VALUE lines (as install.sh and install-windows.ps1 write them); variables already set win. */
export function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

// MARK: - Updates

/** Regular files in a .tar.gz, by path (ustar, GNU long names and pax `path`, as GitHub's archives use). */
export function untarGz(gz) {
  const buf = zlib.gunzipSync(gz);
  const files = new Map();
  let off = 0, nextName = null;
  const field = (h, a, b) => { const s = h.subarray(a, b).toString('utf8'); const z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z); };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(field(h, 124, 136).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = field(h, 345, 500);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { nextName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null; continue; }
    if (type === 'L') { nextName = field(body, 0, body.length); continue; }
    if (type === 'g') continue;
    const name = nextName ?? (prefix ? `${prefix}/` : '') + field(h, 0, 100);
    nextName = null;
    if (type === '0' || type === '7') files.set(name, Buffer.from(body));
  }
  return files;
}
