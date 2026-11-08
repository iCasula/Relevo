#!/usr/bin/env node
// Relevo host: runs agents on a headless machine (e.g. a Linux mini PC) and serves them to Relevo Companion
// on the iPhone, next to the Mac app. Usage:
//   relevo-host.mjs [serve]   start serving (systemd runs this)
//   relevo-host.mjs pair      print the pairing link for the iPhone
//   relevo-host.mjs login     sign in to Claude Code for this host (interactive)
//   relevo-host.mjs status    login, limits and models, without calling a model
//
// Environment (all optional):
//   RELEVO_HOST_DATA   data folder: state, transcripts, Claude Code config, temp and caches (default ~/.relevo-host)
//   RELEVO_PROJECTS    folder whose subfolders are the projects (default $RELEVO_HOST_DATA/projects)
//   RELEVO_HOST_NAME   name shown on the iPhone (default: hostname)
//   RELEVO_PORT        TCP port (default 47820)
//   RELEVO_CLAUDE      path to the `claude` CLI (default: ~/.local/bin/claude or PATH)
//   RELEVO_CLAUDE_CONFIG  Claude Code config folder for this host (default $RELEVO_HOST_DATA/claude-config)
//   RELEVO_MAX_AGENTS  agent processes alive at once (default 2)
//   RELEVO_MIN_FREE_GB_DATA / RELEVO_MIN_FREE_GB_PROJECTS   refuse to start a turn below this (default 1 / 2)
//   RELEVO_FAKE_AGENT=1  echo agent for tests (no Claude calls)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Host } from './lib/host.mjs';
import { probe } from './lib/claude.mjs';

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
  const local = path.join(os.homedir(), '.local/bin/claude');
  const c = {
    dataDir,
    threadsDir: path.join(dataDir, 'threads'),
    claudeConfigDir: path.resolve(env.RELEVO_CLAUDE_CONFIG ?? path.join(dataDir, 'claude-config')),
    tmpDir: path.join(dataDir, 'tmp'),
    cacheDir: path.join(dataDir, 'cache'),
    projectsRoot: path.resolve(env.RELEVO_PROJECTS ?? path.join(dataDir, 'projects')),
    name: env.RELEVO_HOST_NAME ?? os.hostname(),
    port: Number(env.RELEVO_PORT ?? 47820),
    claudeBin: env.RELEVO_CLAUDE ?? (fs.existsSync(local) ? local : which('claude') ?? 'claude'),
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
    host.log(`data ${cfg.dataDir} · projects ${cfg.projectsRoot} · claude ${cfg.claudeBin}${cfg.fakeAgent ? ' (fake agent)' : ''}`);
    const stop = () => { for (const s of host.agents.values()) s.close(true); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    break;
  }
  case 'pair': {
    const host = new Host(cfg);
    console.log(host.pairing);
    break;
  }
  case 'login': {
    fs.mkdirSync(cfg.claudeConfigDir, { recursive: true });
    console.log(`Claude Code login for this host (config in ${cfg.claudeConfigDir}).`);
    const p = spawn(cfg.claudeBin, ['auth', 'login'], { env: cfg.agentEnv, stdio: 'inherit' });
    p.on('exit', (code) => process.exit(code ?? 0));
    break;
  }
  case 'status': {
    fs.mkdirSync(cfg.claudeConfigDir, { recursive: true });
    const s = await probe({ bin: cfg.claudeBin, env: cfg.agentEnv, cwd: cfg.dataDir });
    console.log(JSON.stringify({ ...s, models: s.models?.map((m) => m.id) }, null, 2));
    break;
  }
  default:
    console.error('usage: relevo-host.mjs [serve|pair|login|status]');
    process.exit(2);
}
