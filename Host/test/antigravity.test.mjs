// agy gets the message on stdin, whatever its length: as an argument, a long one doesn't fit a Windows command line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravitySession } from '../lib/antigravity.mjs';

test('a 60k-character message reaches agy whole on stdin, not in its arguments', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-agy-'));
  const seen = path.join(dir, 'seen.json');
  // A stand-in agy: writes down its arguments and what it read, and answers like the real one.
  const bin = path.join(dir, 'agy');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), input }));
  const msg = JSON.parse(input.trim());
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'recibido ' + msg.message.content.length } }));
});
`, { mode: 0o755 });
  const s = new AntigravitySession({ bin, cwd: dir, env: process.env, model: 'gemini-4-neon-medium', mode: 'full', resumeId: 'c0' });
  const texts = [];
  s.on('textFinal', (_, text) => texts.push(text));
  const prompt = `${'Traspaso largo. '.repeat(3800)}\n¿Seguimos con «el menú»? "comillas" & | > %PATH%`;
  const done = new Promise((resolve) => s.on('turnFinished', resolve));
  s.send(prompt);
  await done;
  const got = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.ok(prompt.length > 60_000);
  assert.ok(!got.args.some((a) => a.includes('Traspaso largo')), 'not in the arguments');
  assert.deepEqual(got.args.slice(got.args.indexOf('--input-format'), got.args.indexOf('--input-format') + 2), ['--input-format', 'stream-json']);
  assert.ok(got.args.includes('--conversation') && got.args.includes('c0'), 'it resumes its conversation');
  assert.deepEqual(JSON.parse(got.input.trim()), { event: 'user', message: { content: prompt } });
  assert.deepEqual(texts, [`recibido ${prompt.length}`]);
  fs.rmSync(dir, { recursive: true, force: true });
});
