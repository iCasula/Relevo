// The handoff brief: short however long the thread, code left out, the essentials kept.
// `node --test 'Host/test/*.test.mjs'`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffText, saveTrace, transcript, elideCode, BRIEF_BUDGET } from '../lib/handoff.mjs';

const accounts = new Map([['A', { name: 'Claude', agentName: 'Claude Code' }], ['B', { name: 'Codex', agentName: 'Codex' }]]);
const target = { agentName: 'Antigravity' };
const code = (n, tag) => `\`\`\`ts\n${Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i}; // línea de código ${tag}`).join('\n')}\n\`\`\``;

/** A long session: each turn asks something, edits files, runs tests, and answers with a big code block. */
function longThread(turns = 120) {
  const items = [{ kind: 'user', text: 'OBJETIVO: migrar el login a OAuth sin romper las sesiones' }];
  for (let i = 1; i <= turns; i++) {
    if (i > 1) items.push({ kind: 'user', text: `petición ${i}: sigue con el paso ${i}\n${code(40, `u${i}_`)}` });
    items.push({ kind: 'tool', toolName: 'Read', title: `Leer auth${i}.ts`, toolState: 'done', output: 'x'.repeat(3000) });
    items.push({ kind: 'tool', toolName: 'Edit', title: `Editar auth${i}.ts`, toolState: 'done', output: 'y'.repeat(2000) });
    items.push({ kind: 'tool', toolName: 'Bash', title: 'npm test', toolState: i % 3 ? 'done' : 'failed', output: `$ npm test\n${'salida '.repeat(400)}FALLO en paso ${i}` });
    items.push({ kind: 'assistant', accountId: i % 2 ? 'A' : 'B', text: `Hecho el paso ${i}. Cambié esto:\n${code(80, `a${i}_`)}\nConclusión del paso ${i}.` });
  }
  return items;
}

test('a long thread hands over a brief of a few thousand tokens, not the transcript', () => {
  const items = longThread();
  const full = transcript(items, accounts);
  const brief = handoffText({ items, accounts, projectPath: '/p', target, pendingRequest: false, traceFile: '/p/.relevo/trazas/x.md' });
  assert.ok(brief.length <= BRIEF_BUDGET + 500, `brief is ${brief.length} chars`);
  assert.ok(full.length / brief.length > 20, `only ${Math.round(full.length / brief.length)}× smaller`);
  assert.match(brief, /<objetivo>\nOBJETIVO: migrar el login a OAuth/);
  assert.match(brief, /<ultimo_intercambio>\n### Usuario\npetición 120/);
  assert.match(brief, /Conclusión del paso 120\./, 'the end of the last reply is kept');
  assert.match(brief, /Turno 119 · Usuario: petición 119/);
  assert.match(brief, /turnos anteriores sin resumir aquí: están en la traza/);
  assert.match(brief, /la conversación completa está en \/p\/\.relevo\/trazas\/x\.md/);
});

test('code blocks are left out of the brief; short snippets and commands stay', () => {
  const items = longThread(3);
  items.push({ kind: 'user', text: 'ejecuta esto:\n```sh\nnpm run build\n```' });
  items.push({ kind: 'assistant', accountId: 'A', text: 'Listo' });
  const brief = handoffText({ items, accounts, projectPath: '/p', target, pendingRequest: false });
  assert.doesNotMatch(brief, /línea de código/, 'no code from replies or requests');
  assert.match(brief, /\[código ts, 80 líneas: omitido/);
  assert.match(brief, /```sh\nnpm run build\n```/, 'a three-line snippet is kept');
  assert.equal(elideCode('a\n```\nuno\n```\nb', 6), 'a\n```\nuno\n```\nb');
});

test('turns are summarized by the files they touched and the commands they ran', () => {
  const items = [
    { kind: 'user', text: 'Arregla el login' },
    { kind: 'tool', toolName: 'Write', title: 'Crear oauth.ts', toolState: 'done' },
    { kind: 'tool', toolName: 'Edit', title: 'Editar login.ts', toolState: 'done' },
    { kind: 'tool', toolName: 'Bash', title: 'npm test', toolState: 'failed', output: '$ npm test\n1 failing: expected 200, got 401' },
    { kind: 'assistant', accountId: 'A', text: 'Falla un test de sesión.' },
    { kind: 'user', text: 'mira el test' },
    { kind: 'tool', toolName: 'Bash', title: 'npm test -- session', toolState: 'failed', output: '$ npm test -- session\nTypeError: token is undefined' },
  ];
  const brief = handoffText({ items, accounts, projectPath: '/p', target, pendingRequest: true });
  assert.match(brief, /Turno 1 · Usuario: \(el objetivo\)\n  Claude: Falla un test de sesión\.\n  Ficheros: oauth\.ts \(nuevo\), login\.ts · Comandos: npm test ✗/);
  assert.match(brief, /- npm test -- session → ERROR\n[\s\S]*TypeError: token is undefined/, 'the failure of the cut turn, with its output');
  assert.match(brief, /Este turno se cortó antes de terminar/);
  assert.match(brief, /quedó sin terminar\. Continúa con ella/);
});

test("the agent's latest plan goes with it", () => {
  const items = [
    { kind: 'user', text: 'Haz la migración' },
    { kind: 'tool', toolName: 'TodoWrite', title: 'Plan', toolState: 'done', plan: '[ ] uno\n[ ] dos' },
    { kind: 'tool', toolName: 'TodoWrite', title: 'Plan', toolState: 'done', plan: '[x] uno\n[~] dos\n[ ] tres' },
    { kind: 'assistant', accountId: 'A', text: 'Voy por el dos' },
  ];
  const brief = handoffText({ items, accounts, projectPath: '/p', target, pendingRequest: false });
  assert.match(brief, /<plan>\n\[x\] uno\n\[~\] dos\n\[ \] tres\n<\/plan>/);
});

test('the trace keeps everything, code included, and only the latest few files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-trace-'));
  try {
    const items = longThread(2);
    let file;
    for (let i = 0; i < 10; i++) file = saveTrace({ dir, threadId: `ABCDEF12-${i}`, title: 'Login', items, accounts, workState: '- Rama: main' });
    const doc = fs.readFileSync(file, 'utf8');
    assert.match(doc, /const a2_79 = 79;/);
    assert.match(doc, /## Estado de trabajo\n\n- Rama: main/);
    assert.ok(fs.readdirSync(dir).length <= 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
