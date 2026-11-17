// Subscriptions this host can run, several per provider (each with its own sign-in folder), as on the Mac:
// Claude and Codex with their CLI logins; pay-per-use APIs compatible with Anthropic driven through Claude
// Code (DeepSeek, Anthropic, or any other); and ACP agents (Gemini CLI, or any other).

import path from 'node:path';
import { ClaudeSession, probe as claudeProbe } from './claude.mjs';
import { CodexSession, codexProbe } from './codex.mjs';
import { ACPSession, acpProbe } from './acp.mjs';

const CLAUDE_MODELS = [{ id: 'default', name: 'Predeterminado' }, { id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }];

/** Anthropic-compatible APIs (Claude Code with ANTHROPIC_BASE_URL and a key), like AnthropicAPIProvider.swift. */
export const API_PRESETS = {
  deepseek: {
    name: 'DeepSeek', symbol: 'fish', tint: '#4D6BFE', baseURL: 'https://api.deepseek.com/anthropic', apiRoot: 'https://api.deepseek.com',
    keyURL: 'https://platform.deepseek.com/api_keys', balance: 'deepseek',
    models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }], main: 'deepseek-v4-pro', fast: 'deepseek-v4-flash',
  },
  anthropic: {
    name: 'Anthropic API', symbol: 'key', tint: '#C96442', baseURL: null, keyURL: 'https://console.anthropic.com/settings/keys',
    models: [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }], main: 'sonnet', fast: 'haiku',
  },
  custom: { name: 'API compatible con Anthropic', symbol: 'cpu', tint: '#5B6CFF', models: [], main: null, fast: null },
};

/** ACP agents (ACPAgent.swift on the Mac). */
export const ACP_PRESETS = {
  gemini: { name: 'Gemini CLI', symbol: 'sparkles', tint: '#4285F4', bin: 'gemini', args: ['--experimental-acp'], homeVar: null, login: null },
  custom: { name: 'Agente ACP', symbol: 'cpu', tint: '#6B7280', bin: null, args: [], homeVar: null, login: null },
};

export const TYPES = ['claude', 'codex', 'api', 'acp'];

/**
 * A runtime account from its stored definition: identity, how to launch it (binary, arguments,
 * environment with its own sign-in folder) and how to probe it.
 * def: { id, type, name, preset?, home?, apiKey?, baseURL?, models?, main?, fast?, command?, args? }
 */
export function buildAccount(def, { bins, agentEnv, dataDir }) {
  const home = def.home ?? path.join(dataDir, 'accounts', def.id);
  const base = { id: def.id, def, name: def.name, provider: def.type, status: null, refreshing: false, defaultModel: 'default', loginArgs: null };
  switch (def.type) {
    case 'claude':
      return { ...base, kind: 'claude', agentName: 'Claude Code', symbol: 'asterisk', tint: '#D97857', Session: ClaudeSession, probe: claudeProbe,
        bin: bins.claude, env: { ...agentEnv, CLAUDE_CONFIG_DIR: home }, home, models: CLAUDE_MODELS, loginArgs: ['auth', 'login'] };
    case 'codex':
      return { ...base, kind: 'codex', agentName: 'Codex', symbol: 'hexagon', tint: '#12A380', Session: CodexSession, probe: codexProbe,
        bin: bins.codex, env: { ...agentEnv, CODEX_HOME: home }, home, models: [{ id: 'default', name: 'Predeterminado' }], loginArgs: ['login', '--device-auth'] };
    case 'api': {
      if (def.preset && !API_PRESETS[def.preset]) return null; // a provider Relevo no longer offers
      const p = API_PRESETS[def.preset] ?? API_PRESETS.custom;
      const models = def.models?.length ? def.models : p.models;
      const main = def.main ?? p.main ?? models[0]?.id;
      const fast = def.fast ?? p.fast ?? main;
      const env = { ...agentEnv, CLAUDE_CONFIG_DIR: home };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      const baseURL = def.baseURL ?? p.baseURL;
      if (baseURL) {
        Object.assign(env, { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_AUTH_TOKEN: def.apiKey ?? '' });
        if (main) Object.assign(env, { ANTHROPIC_MODEL: main, ANTHROPIC_DEFAULT_OPUS_MODEL: main, ANTHROPIC_DEFAULT_SONNET_MODEL: main });
        if (fast) Object.assign(env, { ANTHROPIC_DEFAULT_HAIKU_MODEL: fast, ANTHROPIC_SMALL_FAST_MODEL: fast });
      } else env.ANTHROPIC_API_KEY = def.apiKey ?? '';
      return { ...base, kind: `api:${def.preset ?? 'custom'}`, agentName: `Claude Code + ${def.name}`, symbol: p.symbol, tint: p.tint, Session: ClaudeSession,
        probe: () => apiProbe(def, p), bin: bins.claude, env, home, usesAPIKey: true, models: [{ id: 'default', name: `Predeterminado (${models.find((m) => m.id === main)?.name ?? main})` }, ...models] };
    }
    case 'acp': {
      if (def.preset && !ACP_PRESETS[def.preset]) return null;
      const p = ACP_PRESETS[def.preset] ?? ACP_PRESETS.custom;
      const env = { ...agentEnv };
      if (p.homeVar) env[p.homeVar] = home;
      return { ...base, kind: `acp:${def.preset ?? 'custom'}`, agentName: def.name, symbol: p.symbol, tint: p.tint, Session: ACPSession, probe: acpProbe,
        bin: def.command || bins[p.bin] || p.bin, args: def.args?.length ? def.args : p.args, env, home,
        models: [{ id: 'default', name: 'Predeterminado' }], loginArgs: p.login,
        loginHint: p.login ? `${def.name} necesita iniciar sesión: Ajustes › Suscripciones › Iniciar sesión.` : `${def.name} necesita iniciar sesión: ábrelo una vez en una terminal del host.` };
    }
    default: return null;
  }
}

/** A pay-per-use API: signed in when it has a key; its balance when the provider tells (DeepSeek). */
async function apiProbe(def, preset) {
  if (!def.apiKey) return { loggedIn: false, windows: [], error: 'Falta la API key: Ajustes › Suscripciones' };
  const status = { loggedIn: true, windows: [], note: 'Pago por uso', error: null };
  try {
    if (preset.balance === 'deepseek') {
      const r = await fetch(`${preset.apiRoot}/user/balance`, { headers: { Authorization: `Bearer ${def.apiKey}` }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 401) return { loggedIn: false, windows: [], error: 'La API key no es válida' };
      const b = (await r.json()).balance_infos?.[0];
      if (b) status.note = `Saldo: ${Number(b.total_balance).toFixed(2)} ${b.currency}`;
    }
  } catch (e) {
    status.error = `No he podido consultar el saldo: ${e.message}`;
  }
  return status;
}
