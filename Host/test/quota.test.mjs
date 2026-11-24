// Antigravity has four quotas: Gemini's and Claude/GPT's, each with a weekly and a 5-hour window. A thread shows
// the two of its model's family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage } from '../lib/antigravity.mjs';
import { windowsFor } from '../lib/host.mjs';

const USAGE = [
  'Gemini Models\tWeekly Limit Remaining\t94%\t2026-12-01T10:00:00Z',
  'Gemini Models\tFive Hour Limit Remaining\t74%\t2026-11-24T03:00:00Z',
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-12-01T12:00:00Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-24T05:00:00Z',
].join('\n');

test('agy /usage gives the four windows, each named by family and period', () => {
  const ws = parseUsage(USAGE);
  assert.deepEqual(ws.map((w) => [w.label, w.percent]), [['Gemini semana', 6], ['Gemini 5 h', 26], ['Claude/GPT semana', 0], ['Claude/GPT 5 h', 100]]);
});

test('a thread shows the windows of its model family', () => {
  const a = { kind: 'gemini', status: { windows: parseUsage(USAGE) } };
  assert.deepEqual(windowsFor(a, 'claude-sonnet-5').map((w) => w.label), ['Claude/GPT semana', 'Claude/GPT 5 h']);
  assert.deepEqual(windowsFor(a, 'gpt-oss-120b').map((w) => w.label), ['Claude/GPT semana', 'Claude/GPT 5 h']);
  assert.deepEqual(windowsFor(a, 'gemini-4-neon-medium').map((w) => w.label), ['Gemini semana', 'Gemini 5 h']);
  assert.deepEqual(windowsFor(a, 'default').map((w) => w.label), ['Gemini semana', 'Gemini 5 h']);
  // Other providers have one quota for every model.
  const c = { kind: 'claude', status: { windows: [{ id: 'five_hour', label: '5 h', percent: 10 }, { id: 'seven_day', label: 'Semana', percent: 61 }] } };
  assert.equal(windowsFor(c, 'claude-opus-5-5').length, 2);
});
