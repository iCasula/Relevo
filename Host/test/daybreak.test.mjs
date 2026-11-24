// Daybreak (OpenAI's access for cyber work): a per-member switch that asks Codex, turn by turn, for the program
// the member's model accepts with its account.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../lib/host.mjs';
import { CodexSession, daybreakOf } from '../lib/codex.mjs';

test('the catalog says which Daybreak program a model accepts, Blue first', () => {
  assert.equal(daybreakOf({ availableAccessPrograms: { cyber: ['standard', 'daybreakBlue'] } }), 'daybreakBlue');
  assert.equal(daybreakOf({ availableAccessPrograms: { cyber: ['daybreak_red', 'daybreak_blue'] } }), 'daybreakBlue');
  assert.equal(daybreakOf({ availableAccessPrograms: { cyber: ['standard', 'daybreakRed'] } }), 'daybreakRed');
  assert.equal(daybreakOf({ availableAccessPrograms: { cyber: ['standard'] } }), false);
  assert.equal(daybreakOf({ availableAccessPrograms: null }), undefined);
  assert.equal(daybreakOf({}), undefined);
});

test('a thread asks for Daybreak only when switched on, on Codex, with a model that accepts it', () => {
  const codex = { id: 'C', kind: 'codex', models: [{ id: 'gpt-6-sol', daybreak: 'daybreakBlue' }, { id: 'gpt-6.1-sol', daybreak: false }, { id: 'gpt-6-luna' }] };
  const claude = { id: 'A', kind: 'claude', models: [] };
  const h = { _account: (t) => (t.accountId === 'C' ? codex : claude) };
  const cyber = (t) => Host.prototype._cyber.call(h, t);
  assert.equal(cyber({ accountId: 'C', model: 'gpt-6-sol' }), null);
  assert.equal(cyber({ accountId: 'C', model: 'gpt-6-sol', daybreak: true }), 'daybreakBlue');
  assert.equal(cyber({ accountId: 'C', model: 'gpt-6.1-sol', daybreak: true }), null);
  assert.equal(cyber({ accountId: 'C', model: 'gpt-6-luna', daybreak: true }), 'daybreakBlue', 'no catalog data: Codex decides whether it may');
  assert.equal(cyber({ accountId: 'A', model: 'opus', daybreak: true }), null);
});

test('Codex gets the program on every turn, as the model is when it starts', async () => {
  let program = 'daybreakBlue';
  const s = new CodexSession({ bin: 'codex', cwd: '/tmp', env: {}, model: 'gpt-6-sol', mode: 'autoEdit', cyber: () => program });
  const sent = [];
  s.rpc = { request: async (m, p) => { sent.push(p); return { result: { turn: { id: 'T' } } }; } };
  s.threadId = 'X';
  await s._turn('hola');
  program = null;
  await s._turn('sigue');
  assert.equal(sent[0].cyberAccessProgram, 'daybreakBlue');
  assert.equal('cyberAccessProgram' in sent[1], false);
});
