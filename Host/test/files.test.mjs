import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageFile, readThreadImage } from '../lib/files.mjs';

test('a file:// link path from the iPhone (/V:/…) is the drive path on Windows', () => {
  assert.equal(imageFile('/V:/masseffect/out/png/a.png', 'C:\\proj', true), 'V:/masseffect/out/png/a.png');
  assert.equal(imageFile('V:\\out\\a.png', 'C:\\proj', true), 'V:\\out\\a.png');
  assert.equal(imageFile('//wsl.localhost/Ubuntu/home/a.png', 'C:\\proj', true), '//wsl.localhost/Ubuntu/home/a.png');
  assert.equal(imageFile('out/a.png', 'C:\\proj', true), 'C:\\proj\\out\\a.png');
  assert.equal(imageFile('/tmp/a.png', '/proj', false), '/tmp/a.png');
});

test('an image a link names percent-encoded can be read by its decoded path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-img-'));
  const file = path.join(dir, 'a b.png');
  fs.writeFileSync(file, 'png');
  const thread = { projectPath: dir, items: [{ text: `[a b.png](file://${encodeURI(file)})` }] };
  assert.equal(String(readThreadImage(thread, file)), 'png');
  assert.throws(() => readThreadImage({ projectPath: dir, items: [] }, file), /no aparece/);
  fs.rmSync(dir, { recursive: true });
});
