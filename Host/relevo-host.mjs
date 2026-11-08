#!/usr/bin/env node
// Relevo host: runs agents on a headless machine (e.g. a Linux mini PC) and serves them to Relevo Companion
// on the iPhone, next to the Mac app. Usage:
//   relevo-host.mjs [serve]   start serving (systemd runs this)
//   relevo-host.mjs pair      print the pairing link for the iPhone
//   relevo-host.mjs login [claude|codex]   sign in for this host (interactive; Codex uses a device code)
//   relevo-host.mjs status    login, limits and models of each agent, without calling a model
//   relevo-host.mjs update    replace the program with the latest version on GitHub and restart the service
//
// Environment (all optional):
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Host, PROVIDERS } from './lib/host.mjs';

function which(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

function config() {
  const env = process.env;
  const dataDir = path.resolve(env.RELEVO_HOST_DATA ?? path.join(os.homedir(), '.relevo-host'));
  const cli = (name, override) => {
    if (override) return override;
    const local = path.join(os.homedir(), '.local/bin', name);
    return fs.existsSync(local) ? local : which(name);
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
    const host = new Host(cfg);
    host.listen();
    host.log(`data ${cfg.dataDir} · projects ${cfg.projectsRoot} · ${cfg.providers.map((p) => `${p.provider} ${p.bin}`).join(' · ')}${cfg.fakeAgent ? ' (fake agent)' : ''}`);
    const stop = () => { for (const s of host.agents.values()) s.close(true); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    // `relevo-host login` sends it so the iPhone sees the new session without waiting for the next probe.
    process.on('SIGHUP', () => { host.log('SIGHUP: probing the accounts again'); host.refreshUsage(); });
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
    const child = spawn(p.bin, args, { env: cfg.agentEnv, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) {
        // Only the service's main process: `systemctl kill` would also signal the agents it runs.
        const show = spawnSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'relevo-host'], { encoding: 'utf8' });
        const pid = Number(show.stdout?.trim());
        if (pid > 0) { try { process.kill(pid, 'SIGHUP'); console.log('The running service will pick up the new session.'); } catch {} }
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
    // Only Host/ from the repository's latest commit: no git checkout and nothing outside the data folder.
    const repo = process.env.RELEVO_REPO ?? 'iCasula/Relevo';
    const appDir = path.dirname(new URL(import.meta.url).pathname);
    fs.mkdirSync(cfg.tmpDir, { recursive: true });
    const work = fs.mkdtempSync(path.join(cfg.tmpDir, 'update-'));
    try {
      const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/refs/heads/main`);
      if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
      const archive = path.join(work, 'main.tar.gz');
      fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      const tar = spawn('tar', ['-xzf', archive, '-C', work, '--wildcards', '*/Host/relevo-host.mjs', '*/Host/lib/*'], { stdio: 'inherit' });
      if (await new Promise((r) => tar.on('exit', r)) !== 0) throw new Error('tar failed');
      const [top] = fs.readdirSync(work).filter((n) => n !== 'main.tar.gz');
      const src = path.join(work, top, 'Host');
      fs.cpSync(path.join(src, 'lib'), path.join(appDir, 'lib'), { recursive: true });
      fs.copyFileSync(path.join(src, 'relevo-host.mjs'), path.join(appDir, 'relevo-host.mjs'));
      console.log(`Updated from ${repo} (${top}).`);
    } catch (e) {
      console.error(`Update failed: ${e.message}`);
      process.exitCode = 1;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    if (!process.exitCode) {
      const r = spawn('systemctl', ['--user', 'restart', 'relevo-host'], { stdio: 'inherit' });
      r.on('exit', (code) => console.log(code === 0 ? 'Service restarted.' : 'Restart it with: systemctl --user restart relevo-host'));
    }
    break;
  }
  default:
    console.error('usage: relevo-host.mjs [serve|pair|login|status|update]');
    process.exit(2);
}
