// The guard: ordinary work goes on by itself, what can't be undone waits for you.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommand, checkRequest, normalize } from '../lib/guard.mjs';

const W = { roots: ['V:\\masseffect\\me1-sw2', 'C:\\Users\\halco\\AppData\\Local\\RelevoHost\\data', 'C:\\Users\\halco\\AppData\\Local\\Temp'], cwd: 'V:\\masseffect\\me1-sw2', platform: 'win32' };
const U = { roots: ['/home/u/proj', '/tmp'], cwd: '/home/u/proj', platform: 'linux' };
const held = (cmd, ctx = W) => checkCommand(cmd, ctx)?.reason ?? null;

test('ordinary work goes on by itself', () => {
  for (const cmd of [
    "wsl.exe -d Ubuntu -- bash -lc 'cd /mnt/v/masseffect/me1-sw2; make -C runtime/host all'",
    'git status --short; git diff --check',
    'git add -A && git commit -m "wip" && git push origin master',
    "Get-Content -LiteralPath PROGRESS.md -Tail 25",
    'cmake --build build --config Release',
    'rm build/old.o',
    'Remove-Item out\\probe.txt',
    'Copy-Item C:\\Users\\halco\\Desktop\\token.txt V:\\masseffect\\me1-sw2\\.secrets\\token.txt',
    'cp /usr/lib/libfoo.so ./vendor/',
    'echo hola > /dev/null',
    'mkdir -p /mnt/v/masseffect/me1-sw2/out/run1',
    'python3 tools/check_nro.py out/lift.nro',
  ]) assert.equal(held(cmd), null, cmd);
  assert.equal(held('cp /usr/lib/libfoo.so ./vendor/', U), null);
});

test('recursive and mass deletions wait for you, inside the project too', () => {
  assert.match(held('rm -rf build'), /recursivo/);
  assert.match(held('sudo rm -r /mnt/v/masseffect'), /recursivo/);
  assert.match(held("find . -name '*.o' -delete"), /find -delete/);
  assert.match(held('Remove-Item -Recurse -Force out'), /Remove-Item -Recurse/);
  assert.match(held('del /s /q *.tmp'), /del \/s/);
  assert.match(held('rmdir /s /q dist'), /rmdir \/s/);
  assert.match(held("wsl.exe -d Ubuntu -- bash -lc 'cd /mnt/v/x; rm -rf out'"), /recursivo/);
  assert.match(held('powershell -Command "Remove-Item V:\\masseffect -Recurse"'), /Remove-Item -Recurse/);
  assert.match(held('python3 -c "import shutil; shutil.rmtree(\'out\')"'), /desde código/);
});

test('git commands that throw work away wait for you', () => {
  assert.match(held('git clean -fdx'), /git clean/);
  assert.match(held('git reset --hard HEAD~3'), /reset --hard/);
  assert.match(held('git checkout -- .'), /descarta/);
  assert.match(held('git push --force origin master'), /push --force/);
  assert.equal(held('git checkout -b nueva'), null);
});

test('deleting, moving or writing outside the project waits for you', () => {
  assert.match(held('Remove-Item I:\\recuvaV\\masseffect\\x.txt'), /fuera de la carpeta/);
  assert.match(held('rm /mnt/i/recuvaV/file.bin'), /fuera de la carpeta/);
  assert.match(held('Move-Item V:\\masseffect\\me1-sw2\\dist D:\\backup'), /fuera de la carpeta/);
  assert.match(held('echo x > C:\\Windows\\System32\\drivers\\etc\\hosts'), /fuera de la carpeta/);
  assert.match(held('Set-Content -Path D:\\notes.txt -Value hola'), /fuera de la carpeta/);
  assert.match(held('rm ../../otro/fichero'), /fuera de la carpeta/);
  assert.match(held('Remove-Item V:\\'), /raíz/);
  assert.match(held('rm $TARGET/file'), /variable/);
  assert.match(held('Remove-Item %OUT%\\x'), /variable/);
  assert.match(held('format D: /q'), /formateo/);
});

test('file tools and file changes outside the project wait for you', () => {
  assert.equal(checkRequest({ toolName: 'Write', input: { file_path: 'V:\\masseffect\\me1-sw2\\README.md' } }, W), null);
  assert.equal(checkRequest({ toolName: 'Edit', input: { file_path: 'src/a.c' } }, W), null);
  assert.match(checkRequest({ toolName: 'Write', input: { file_path: 'D:\\otra\\x.c' } }, W).reason, /fuera/);
  assert.match(checkRequest({ toolName: 'fileChange', grantRoot: 'C:\\' }, W).reason, /fuera/);
  assert.match(checkRequest({ toolName: 'Bash', input: { command: 'rm -rf node_modules' } }, U).reason, /recursivo/);
  assert.equal(checkRequest({ toolName: 'Bash', input: { command: 'npm test' } }, U), null);
});

test('paths are compared the same whichever way they are written', () => {
  assert.equal(normalize('/mnt/v/masseffect/me1-sw2/out', 'win32'), 'v:\\masseffect\\me1-sw2\\out');
  assert.equal(normalize('V:/MassEffect/me1-sw2/', 'win32'), 'v:\\masseffect\\me1-sw2');
});
