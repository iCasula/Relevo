// Quota errors from each agent are recognised as limits (so a thread relays or waits), with when they reset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, resetFromText } from '../lib/claude.mjs';
import { AntigravitySession } from '../lib/antigravity.mjs';

test('quota messages are limits, and «resets in …» says when', () => {
  const agy = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 166h28m11s.';
  assert.equal(classify(agy), 'limit');
  assert.equal(resetFromText(agy, 0), 166 * 3600 + 28 * 60 + 11);
  assert.equal(classify("You've hit your 5-hour limit · resets 12:50pm"), 'limit');
  assert.equal(classify('RESOURCE_EXHAUSTED: quota exceeded'), 'limit');
  assert.equal(classify('Segmentation fault'), 'other');
  assert.equal(resetFromText('no reset here'), null);
});

test("after Antigravity's quota error, its silent exits are still the limit", () => {
  const s = Object.create(AntigravitySession.prototype);
  const failures = [];
  s.emit = (name, f) => { if (name === 'failure') failures.push(f); };
  s.failed = false;
  s.model = 'gemini-3.8-flash-low';
  s._fail('limit', 'Individual quota reached. Resets in 2h.');
  s.failed = false; // the next turn
  s._fail('other', 'Antigravity terminó con código 1.');
  assert.equal(failures[1].kind, 'limit');
  assert.ok(failures[1].resetsAt > Date.now() / 1000 + 3600);
  assert.match(failures[1].message, /sigue sin cuota/);
  // Another model (Claude inside Antigravity has its own quota): a plain error stays a plain error.
  s.model = 'claude-sonnet-4-6';
  s.failed = false;
  s._fail('other', 'Antigravity terminó con código 1.');
  assert.equal(failures[2].kind, 'other');
});

test('read-only commands are told apart from ones that write, build or delete', async () => {
  const { isReadOnlyCommand: reads } = await import('../lib/codex.mjs');
  for (const c of ['rg -n -i "image descriptor|t#" C:\\src\\video_core', "$f='C:\\x.h'; $a=Get-Content $f; $a[1..240]",
    'Get-Content tiling.comp | Select-Object -First 260', 'git log --oneline -n 5 && git status --short']) assert.ok(reads(c), c);
  for (const c of ['git commit -m x', 'Remove-Item -Recurse out', 'Get-Content a.txt > b.txt', 'ninja -C build',
    'npm install', 'rg foo; rm -rf build', 'python tools/framecap.py x']) assert.ok(!reads(c), c);
});
