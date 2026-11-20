// What a host sends after the first snapshot: only what changed, and the client rebuilds the same snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshot, applySnapshotPatch } from '../ui/state.mjs';

const base = {
  macName: 'TORRE', autoRelay: false,
  threads: [{ id: 'A', title: 'Orquestador', preview: 'hola', updatedAt: 1, attention: null }, { id: 'B', title: 'Ejecutor', worktree: 'w' }],
  hostTeams: [{ id: 'T', goal: 'Juego', findings: [{ id: 1, topic: 'x', summary: 'y'.repeat(5000) }], members: [{ threadId: 'A', task: { state: 'en curso' } }] }],
};

test('nothing changed: nothing to send', () => {
  assert.equal(diffSnapshot(base, structuredClone(base)), null);
});

test('a preview changes: only that field of that thread travels, not the team library', () => {
  const next = structuredClone(base);
  next.threads[0].preview = 'adiós';
  next.threads[0].updatedAt = 2;
  const patch = diffSnapshot(base, next);
  assert.deepEqual(patch, { lists: { threads: { ids: ['A', 'B'], upsert: [{ preview: 'adiós', updatedAt: 2, id: 'A' }] } } });
  assert.deepEqual(applySnapshotPatch(base, patch), next);
});

test('entries added, removed, reordered, fields dropped and top-level keys gone all come back the same', () => {
  const next = structuredClone(base);
  delete next.autoRelay;
  next.pushReady = true;
  next.threads = [{ id: 'C', title: 'Nuevo' }, { id: 'B', title: 'Ejecutor' }];
  next.hostTeams[0].members[0].task.state = 'bloqueado';
  const patch = diffSnapshot(base, next);
  assert.ok(!JSON.stringify(patch).includes('yyyy'), 'the findings did not change and do not travel');
  assert.deepEqual(applySnapshotPatch(base, patch), next);
});
