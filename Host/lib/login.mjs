// Signing in to an agent from any client (the desktop app, the iPhone) instead of a terminal on the host:
// the CLI's login runs with its output streamed to the client, which shows the link to open and sends back
// what it asks for (Claude: the code shown after signing in; Codex: nothing, it uses a device code).

import { EventEmitter } from 'node:events';
import { spawnCLI, killTree } from './platform.mjs';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const TIMEOUT_MS = 15 * 60_000;

export class LoginSession extends EventEmitter {
  constructor({ bin, args, env, cwd, doneWhen }) {
    super();
    this.output = '';
    this.done = false;
    // No browser to open from a service: the link goes to the client instead.
    this.proc = spawnCLI(bin, args, { env: { ...env, BROWSER: 'none' }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const onData = (d) => {
      const text = d.toString().replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
      this.output = (this.output + text).slice(-16_000);
      this.emit('output', text);
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', (e) => this._finish(false, e.message));
    this.proc.on('exit', (code) => this._finish(code === 0, code === 0 ? null : `El inicio de sesión terminó con código ${code}`));
    this.timer = setTimeout(() => { this.cancel(); }, TIMEOUT_MS);
    if (doneWhen) {
      const since = Date.now();
      this.poll = setInterval(() => { if (doneWhen(since)) { killTree(this.proc); this._finish(true, null); } }, 1500);
    }
  }

  input(text) {
    if (!this.done && this.proc.stdin.writable) this.proc.stdin.write(`${String(text).trim()}\n`);
  }

  cancel() {
    if (this.done) return;
    killTree(this.proc);
    this._finish(false, 'Cancelado');
  }

  _finish(ok, error) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.emit('done', { ok, error });
  }
}
