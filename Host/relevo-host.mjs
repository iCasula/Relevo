#!/usr/bin/env node
// Relevo host: runs agents on a headless machine (e.g. a Linux mini PC) and serves them to Relevo Companion
// on the iPhone, next to the Mac app. Usage:
//   relevo-host.mjs [serve]   start serving (systemd runs this on Linux, a scheduled task on Windows)
//   relevo-host.mjs pair      print the pairing link for the iPhone
//   relevo-host.mjs login [claude|codex]   sign in for this host (interactive; Codex uses a device code)
//   relevo-host.mjs status    login, limits and models of each agent, without calling a model
//   relevo-host.mjs update    replace the program with the latest version on GitHub and restart the service
//   relevo-host.mjs logs [n]  last lines of <data>/logs/host.log (where the supervisor writes; on Linux, journalctl)
//
// Settings come from the environment and from `host.env` next to the program's folder (<base>/host.env for
// <base>/app/relevo-host.mjs, as the installers lay it out), or the file in RELEVO_ENV_FILE. All optional:
//   RELEVO_HOST_DATA   data folder: state, transcripts, Claude Code config, temp and caches (default ~/.relevo-host)
//   RELEVO_PROJECTS    folder whose subfolders are the projects (default $RELEVO_HOST_DATA/projects)
//   RELEVO_HOST_NAME   name shown on the iPhone (default: hostname)
//   RELEVO_PORT        TCP port (default 47820)
//   RELEVO_CLAUDE      path to the `claude` CLI (default: ~/.local/bin/claude or PATH)
//   RELEVO_CLAUDE_CONFIG  Claude Code config folder for this host (default $RELEVO_HOST_DATA/claude-config)
//   RELEVO_CODEX       path to the `codex` CLI (default: ~/.local/bin/codex or PATH)
//   RELEVO_CODEX_HOME  Codex's folder for this host (default $RELEVO_HOST_DATA/codex-home)
//   RELEVO_PROVIDERS   agents to offer, in order (default "claude,codex"; those without a CLI are left out)
//   RELEVO_MAX_AGENTS  agent processes alive at once (default 2)
//   RELEVO_MIN_FREE_GB_DATA / RELEVO_MIN_FREE_GB_PROJECTS   refuse to start a turn below this (default 1 / 2)
//   RELEVO_FAKE_AGENT=1  echo agent for tests (no Claude calls)
//   RELEVO_REPO        GitHub repository `update` downloads from (default iCasula/Relevo, branch main)
//   RELEVO_SUPERVISE   1: `serve` restarts its worker when it exits or after an update, logging to
//                      <data>/logs/host.log (default on Windows, where no systemd does it)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Host, PROVIDERS } from './lib/host.mjs';
import { isWindows, which, findIn, spawnCLI, killTree, requestControl, watchControl, loadEnvFile, untarGz } from './lib/platform.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(SCRIPT);
const RESTART_EXIT_CODE = 75;
loadEnvFile(process.env.RELEVO_ENV_FILE ?? path.join(APP_DIR, '..', 'host.env'));

function config() {
  const env = process.env;
  const dataDir = path.resolve(env.RELEVO_HOST_DATA ?? path.join(os.homedir(), '.relevo-host'));
  const cli = (name, override) => {
    if (override) return override;
    return findIn(path.join(os.homedir(), '.local', 'bin'), name) ?? which(name);
  };
  const bins = { claude: cli('claude', env.RELEVO_CLAUDE), codex: cli('codex', env.RELEVO_CODEX) };
  const c = {
    dataDir,
    threadsDir: path.join(dataDir, 'threads'),
    claudeConfigDir: path.resolve(env.RELEVO_CLAUDE_CONFIG ?? path.join(dataDir, 'claude-config')),
    codexHome: path.resolve(env.RELEVO_CODEX_HOME ?? path.join(dataDir, 'codex-home')),
    tmpDir: path.join(dataDir, 'tmp'),
    cacheDir: path.join(dataDir, 'cache'),
    projectsRoot: path.resolve(env.RELEVO_PROJECTS ?? path.join(dataDir, 'projects')),
    name: env.RELEVO_HOST_NAME ?? os.hostname(),
    port: Number(env.RELEVO_PORT ?? 47820),
    providers: (env.RELEVO_PROVIDERS ?? 'claude,codex').split(',').map((p) => p.trim())
      .filter((p) => PROVIDERS[p] && (bins[p] || env.RELEVO_FAKE_AGENT === '1'))
      .map((provider) => ({ provider, bin: bins[provider] ?? provider })),
    maxAgents: Number(env.RELEVO_MAX_AGENTS ?? 2),
    minFreeDataBytes: Number(env.RELEVO_MIN_FREE_GB_DATA ?? 1) * 1e9,
    minFreeProjectsBytes: Number(env.RELEVO_MIN_FREE_GB_PROJECTS ?? 2) * 1e9,
    fakeAgent: env.RELEVO_FAKE_AGENT === '1',
  };
  // Everything the agents write outside the project goes to the data folder, never to the system disk:
  // Claude Code's config and transcripts, temp files and the caches of the tools they run.
  c.agentEnv = {
    ...env,
    CLAUDE_CONFIG_DIR: c.claudeConfigDir,
    CODEX_HOME: c.codexHome,
    TMPDIR: c.tmpDir,
    ...(isWindows ? { TEMP: c.tmpDir, TMP: c.tmpDir } : {}),
    XDG_CACHE_HOME: c.cacheDir,
    npm_config_cache: path.join(c.cacheDir, 'npm'),
    UV_CACHE_DIR: path.join(c.cacheDir, 'uv'),
    PIP_CACHE_DIR: path.join(c.cacheDir, 'pip'),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
  };
  return c;
}

const cfg = config();
const command = process.argv[2] ?? 'serve';

switch (command) {
  case 'serve': {
    if ((process.env.RELEVO_SUPERVISE ?? (isWindows ? '1' : '0')) === '1') { supervise(); break; }
    const host = new Host(cfg);
    host.listen();
    host.log(`data ${cfg.dataDir} · projects ${cfg.projectsRoot} · ${cfg.providers.map((p) => `${p.provider} ${p.bin}`).join(' · ')}${cfg.fakeAgent ? ' (fake agent)' : ''}`);
    const stop = (code = 0) => { for (const s of host.agents.values()) s.close(true); process.exit(code); };
    process.on('SIGTERM', () => stop());
    process.on('SIGINT', () => stop());
    const refresh = (why) => { host.log(`${why}: probing the accounts again`); host.refreshUsage(); };
    if (!isWindows) process.on('SIGHUP', () => refresh('SIGHUP'));
    // `relevo-host login` asks for a probe so the iPhone sees the new session at once; `update` for a restart
    // (the supervisor or systemd starts the new version).
    watchControl(cfg.dataDir, {
      refresh: () => refresh('login'),
      restart: () => { host.log('restarting for the update'); stop(RESTART_EXIT_CODE); },
    });
    // Under the supervisor: if it's gone (a scheduled task stopped by force), don't stay behind holding the port.
    const parent = Number(process.env.RELEVO_SUPERVISOR_PID);
    if (parent > 0) setInterval(() => { try { process.kill(parent, 0); } catch { stop(); } }, 5000).unref();
    break;
  }
  case 'pair': {
    const host = new Host(cfg);
    console.log(host.pairing);
    break;
  }
  case 'login': {
    const agent = process.argv[3] ?? cfg.providers[0]?.provider;
    const p = cfg.providers.find((x) => x.provider === agent);
    if (!p) { console.error(`Unknown or missing agent: ${agent}. Available: ${cfg.providers.map((x) => x.provider).join(', ')}`); process.exit(2); }
    for (const dir of [cfg.claudeConfigDir, cfg.codexHome]) fs.mkdirSync(dir, { recursive: true });
    const args = agent === 'codex' ? ['login', '--device-auth'] : ['auth', 'login'];
    console.log(`${PROVIDERS[agent].name} login for this host (${agent === 'codex' ? cfg.codexHome : cfg.claudeConfigDir}).`);
    const child = spawnCLI(p.bin, args, { env: cfg.agentEnv, stdio: 'inherit' });
    child.on('error', (e) => { console.error(e.message); process.exit(1); });
    child.on('exit', (code) => {
      if (code === 0) {
        requestControl(cfg.dataDir, 'refresh');
        console.log('The running service will pick up the new session.');
      }
      process.exit(code ?? 0);
    });
    break;
  }
  case 'status': {
    for (const dir of [cfg.claudeConfigDir, cfg.codexHome]) fs.mkdirSync(dir, { recursive: true });
    for (const { provider, bin } of cfg.providers) {
      const s = await PROVIDERS[provider].probe({ bin, env: cfg.agentEnv, cwd: cfg.dataDir });
      console.log(`${provider}: ${JSON.stringify({ ...s, models: s.models?.map((m) => m.id) }, null, 2)}`);
    }
    break;
  }
  case 'update': {
    // Only Host/ from the repository's latest commit: no git checkout, no `tar` binary (Windows may lack one)
    // and nothing outside the program's folder.
    const repo = process.env.RELEVO_REPO ?? 'iCasula/Relevo';
    try {
      const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/refs/heads/main`);
      if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
      const wanted = /^([^/]+)\/Host\/(relevo-host\.mjs|lib\/[\w.-]+\.mjs)$/;
      const files = [...untarGz(Buffer.from(await res.arrayBuffer()))].map(([name, data]) => [wanted.exec(name), data]).filter(([m]) => m);
      if (!files.some(([m]) => m[2] === 'relevo-host.mjs')) throw new Error('relevo-host.mjs is not in the archive');
      fs.mkdirSync(path.join(APP_DIR, 'lib'), { recursive: true });
      for (const [m, data] of files) {
        const dest = path.join(APP_DIR, ...m[2].split('/'));
        fs.writeFileSync(`${dest}.new`, data);
        fs.renameSync(`${dest}.new`, dest);
      }
      console.log(`Updated from ${repo} (${files[0][0][1]}, ${files.length} files).`);
    } catch (e) {
      console.error(`Update failed: ${e.message}`);
      process.exitCode = 1;
    }
    if (!process.exitCode) {
      const systemd = !isWindows && spawnSync('systemctl', ['--user', 'cat', 'relevo-host'], { stdio: 'ignore' }).status === 0;
      if (systemd) {
        const r = spawn('systemctl', ['--user', 'restart', 'relevo-host'], { stdio: 'inherit' });
        r.on('exit', (code) => console.log(code === 0 ? 'Service restarted.' : 'Restart it with: systemctl --user restart relevo-host'));
      } else {
        requestControl(cfg.dataDir, 'restart');
        console.log('The running service restarts with the new version in a few seconds.');
      }
    }
    break;
  }
  case 'logs': {
    const file = path.join(cfg.dataDir, 'logs', 'host.log');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { console.error(`No log yet at ${file}${isWindows ? '' : ' (under systemd: journalctl --user -u relevo-host)'}`); process.exit(1); }
    console.log(text.trimEnd().split('\n').slice(-Number(process.argv[3] ?? 50)).join('\n'));
    break;
  }
  default:
    console.error('usage: relevo-host.mjs [serve|pair|login|status|update|logs]');
    process.exit(2);
}

/**
 * Keeps a `serve` worker running, as systemd does on Linux: it starts it again when it exits (at once after an
 * update, backing off if it keeps failing) and appends its output to <data>/logs/host.log.
 */
function supervise() {
  const logDir = path.join(cfg.dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'host.log');
  let child = null, stopping = false, failures = 0;
  const start = () => {
    try { if (fs.statSync(logFile).size > 5e6) fs.renameSync(logFile, `${logFile}.1`); } catch {}
    const out = fs.openSync(logFile, 'a');
    const startedAt = Date.now();
    child = spawn(process.execPath, [SCRIPT, 'serve'], {
      env: { ...process.env, RELEVO_SUPERVISE: '0', RELEVO_SUPERVISOR_PID: String(process.pid) },
      stdio: ['ignore', out, out], windowsHide: true,
    });
    fs.closeSync(out);
    child.on('exit', (code) => {
      if (stopping) process.exit(0);
      failures = code === RESTART_EXIT_CODE ? 0 : Date.now() - startedAt < 30_000 ? failures + 1 : 0;
      const delay = code === RESTART_EXIT_CODE ? 500 : Math.min(60_000, 2000 * 2 ** failures);
      fs.appendFileSync(logFile, `[supervisor] worker exited (${code}); starting it again in ${delay / 1000} s\n`);
      setTimeout(start, delay);
    });
  };
  const stop = () => { stopping = true; killTree(child); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`relevo-host: logging to ${logFile}`);
  start();
}
