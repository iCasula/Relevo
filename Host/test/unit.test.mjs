// Pure pieces of the host and the desktop page: `node --test Host/test/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parsePairingLink, applyPatch, applyServerMessage, emptyHostData, Client } from '../ui/state.mjs';
import { markdown, inline } from '../ui/markdown.mjs';
import { compareVersions, verifyManifest, filesFromArchive } from '../lib/updater.mjs';
import { untarGz, npmShimTarget, loadEnvFile } from '../lib/platform.mjs';
import { shellCommand } from '../lib/codex.mjs';
import { classify } from '../lib/claude.mjs';
import { usageReport } from '../lib/usage.mjs';
import { handoffText } from '../lib/handoff.mjs';
import * as gitops from '../lib/gitops.mjs';

const HOST = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-test-'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('pairing links', () => {
  const key = Buffer.alloc(32, 7).toString('base64url');
  const info = parsePairingLink(`relevocompanion://pair?v=1&id=relevo-ab&name=Mini%20PC&key=${key}&port=47820&addrs=10.0.0.2,192.168.1.5`);
  assert.equal(info.serverId, 'relevo-ab');
  assert.equal(info.name, 'Mini PC');
  assert.equal(info.port, 47820);
  assert.deepEqual(info.addresses, ['10.0.0.2', '192.168.1.5']);
  assert.equal(parsePairingLink('https://example.com/?id=x&key=y'), null);
  assert.equal(parsePairingLink('relevocompanion://pair?id=x&key=short'), null);
});

test('thread patches upsert in order and replace live state', () => {
  const t = { id: 'T', title: 'a', items: [{ id: '1', text: 'x' }], totalItems: 1, runtime: { isRunning: true } };
  const next = applyPatch(t, { id: 'T', title: 'b', upserts: [{ id: '1', text: 'y' }, { id: '2', text: 'z' }], totalItems: 2, runtime: { isRunning: false } });
  assert.deepEqual(next.items.map((i) => i.text), ['y', 'z']);
  assert.equal(next.title, 'b');
  assert.equal(t.items[0].text, 'x', 'the old thread is left alone');
  const data = emptyHostData();
  applyServerMessage(data, { thread: { _0: t } });
  applyServerMessage(data, { threadPatch: { _0: { ...next, upserts: [] } } });
  assert.equal(data.threads.get('T').title, 'b');
  assert.deepEqual(Client.setEffort('T', null), { setEffort: { threadId: 'T' } });
});

test('markdown escapes HTML and keeps only safe links', () => {
  const html = markdown('# Hola <b>\n\n- uno\n  - dos\n- tres\n\n```js\nlet a = "<x>";\n```\n\n[ok](https://a.b) [no](javascript:alert(1)) `<i>`');
  assert.match(html, /<h1>Hola &lt;b&gt;<\/h1>/);
  assert.match(html, /<ul><li>uno<ul><li>dos<\/li><\/ul><\/li><li>tres<\/li><\/ul>/);
  assert.match(html, /<pre class="code" data-lang="js"><code>let a = &quot;&lt;x&gt;&quot;;<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/a\.b"/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(inline('**b** _i_ ~~s~~'), /<strong>b<\/strong> <em>i<\/em> <del>s<\/del>/);
});

test('versions compare as numbers; branches sort first', () => {
  assert.ok(compareVersions('v0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.3.0', 'v0.3.0'), 0);
  assert.ok(compareVersions('dev', '0.1.0') < 0);
  assert.ok(compareVersions('v1.0.0', 'main (2026-01-01)') > 0);
});

test('release archives: signature and every file checked', () => {
  const dir = tmp();
  const archivePath = path.join(dir, 'a.tar.gz');
  execFileSync('git', ['archive', '--format=tar.gz', '--prefix=relevo-test/', '-o', archivePath, 'HEAD', 'Host'], { cwd: path.dirname(HOST) });
  const archive = fs.readFileSync(archivePath);
  const files = {};
  for (const [name, data] of untarGz(archive)) {
    const rel = name.replace(/^relevo-test\/Host\//, '');
    if (/^(relevo-host\.mjs|VERSION|lib\/[\w.-]+\.mjs|ui\/[\w.-]+\.(?:html|css|mjs|png|ico|svg|webmanifest))$/.test(rel)) files[rel] = sha256(data);
  }
  const manifest = { tag: 'v9.9.9', archive: sha256(archive), files };
  assert.ok(filesFromArchive(archive, manifest).has('relevo-host.mjs'));
  assert.throws(() => filesFromArchive(archive, { ...manifest, files: { ...files, 'lib/host.mjs': '0'.repeat(64) } }), /no coincide/);
  assert.throws(() => filesFromArchive(archive, { ...manifest, files: { ...files, 'lib/missing.mjs': '0'.repeat(64) } }), /Falta/);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const bytes = Buffer.from(JSON.stringify(manifest));
  const sig = crypto.sign(null, bytes, privateKey).toString('base64');
  assert.ok(verifyManifest(bytes, sig, pub));
  assert.ok(!verifyManifest(Buffer.from(JSON.stringify({ ...manifest, tag: 'v9.9.8' })), sig, pub));
  assert.ok(!verifyManifest(bytes, sig), 'a key other than the release key fails');
});

test('Codex shell wrappers come off, on every platform', () => {
  const cases = [
    [`/usr/bin/bash -lc 'cat hola.txt'`, 'cat hola.txt'],
    [`bash -lc 'echo '\\''hi'\\'''`, `echo 'hi'`],
    [`"C:\\Program Files\\Git\\bin\\bash.exe" -lc 'ls -la'`, 'ls -la'],
    [`C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command 'Get-Content a.txt'`, 'Get-Content a.txt'],
    [`pwsh -NoLogo -NoProfile -c 'dir'`, 'dir'],
    [`cmd.exe /c "dir /b"`, 'dir /b'],
    ['git status', 'git status'],
  ];
  for (const [input, output] of cases) assert.equal(shellCommand(input), output, input);
});

test('errors are classified by specific phrases only', () => {
  assert.equal(classify('Claude AI usage limit reached|1760000000'), 'limit');
  assert.equal(classify('API Error: 401 {"type":"authentication_error"}'), 'auth');
  assert.equal(classify('Not logged in · Please run /login'), 'auth');
  assert.equal(classify('overloaded_error'), 'unavailable');
  assert.equal(classify('test output: expected 401 to equal 200; quota tests skipped; capacity 3'), 'other');
});

test('usage report groups by model, day and thread', () => {
  const now = Date.now() / 1000;
  const accounts = new Map([['A', { id: 'A', name: 'Claude' }]]);
  const threads = [{ id: 'T', title: 'Uno', accountId: 'A', items: [
    { kind: 'assistant', accountId: 'A', model: 'opus', date: now, usage: { tokens: 100, cost: 0.5 } },
    { kind: 'assistant', accountId: 'A', model: 'opus', date: now, usage: { tokens: 50, cost: 0.25 } },
    { kind: 'assistant', accountId: 'A', model: 'opus', date: now - 400 * 86_400, usage: { tokens: 999, cost: 9 } },
  ] }];
  const r = usageReport(threads, accounts, { days: 30 });
  assert.equal(r.total.turns, 2);
  assert.equal(r.total.tokens, 150);
  assert.equal(r.byModel[0].accountName, 'Claude');
  assert.equal(r.byThread[0].title, 'Uno');
  assert.equal(usageReport(threads, accounts, { days: 0 }).total.turns, 3);
});

test('handoff carries the transcript and the work state', () => {
  const text = handoffText({
    items: [{ kind: 'user', text: 'Arregla el login' }, { kind: 'assistant', text: 'Hecho', accountId: 'A' }],
    accounts: new Map([['A', { name: 'Claude', agentName: 'Claude Code' }]]), projectPath: '/p',
    target: { agentName: 'Codex' }, pendingRequest: true, workState: '- Rama: main',
  });
  assert.match(text, /<estado_de_trabajo>\n- Rama: main\n<\/estado_de_trabajo>/);
  assert.match(text, /### Usuario\nArregla el login/);
  assert.match(text, /quedó sin terminar/);
});

test('git: status, diff, commit and work state', async () => {
  const dir = tmp();
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\ndos\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'nuevo\n');
  const s = gitops.status(dir);
  assert.ok(s.repo);
  assert.deepEqual(s.files.map((f) => [f.path, f.kind, f.added]), [['a.txt', 'modified', 1], ['b.txt', 'new', 1]]);
  assert.match(gitops.diff(dir), /\+dos/);
  assert.match(gitops.diff(dir, 'b.txt'), /\+nuevo/);
  assert.match(gitops.workState(dir), /modificado: a\.txt/);
  const r = await gitops.commit(dir, { message: 'Cambios', push: false });
  assert.ok(r.ok, r.output);
  assert.equal(gitops.status(dir).files.length, 0);
  assert.equal(gitops.status(tmp()).repo, false);
});

test('npm shims and settings files', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'node_modules/@openai/codex/bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/@openai/codex/bin/codex.js'), '');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.equal(npmShimTarget(path.join(dir, 'codex.cmd')), path.join(dir, 'node_modules/@openai/codex/bin/codex.js'));
  fs.writeFileSync(path.join(dir, 'host.env'), '\uFEFF# c\r\nRELEVO_TEST_A=a b\r\nRELEVO_TEST_B="C:\\x"\r\n');
  loadEnvFile(path.join(dir, 'host.env'));
  assert.equal(process.env.RELEVO_TEST_A, 'a b');
  assert.equal(process.env.RELEVO_TEST_B, 'C:\\x');
});
