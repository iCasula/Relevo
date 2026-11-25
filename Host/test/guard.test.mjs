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

test('what TORRE stopped by mistake goes on by itself', () => {
  const tw = { ...W, cwd: 'C:\\Users\\halco\\AppData\\Local\\RelevoHost\\data\\worktrees\\me1-sw2-f2c060' };
  for (const cmd of [
    // Git Bash writes drives as /v/…
    'cp /c/Users/halco/AppData/Local/RelevoHost/data/worktrees/me1-sw2-f2c060/tools/cap_compute_vsharp.py /v/masseffect/me1-sw2/tools/; cd /v/masseffect/me1-sw2; git add tools/cap_compute_vsharp.py',
    // A program run from outside the project, writing only through a redirect into it or into /tmp.
    "cd /v/masseffect/me1-sw2/runtime/switch && (wsl -d Ubuntu -- bash -lc 'cd /mnt/v/masseffect/me1-sw2/runtime/switch && /opt/devkitpro/devkitA64/bin/aarch64-none-elf-objdump -d runtime-lift.elf > /tmp/lift.dis 2>/dev/null; grep -c \"x18\" /tmp/lift.dis' > /tmp/dis_out.txt 2>&1 &) ; sed -n 1,60p source/lift_threads.c",
    "wsl.exe --distribution Ubuntu -- bash -lc 'cd /mnt/v/masseffect/me1-sw2/runtime/host; timeout 2s env ME1_ENTRY=0x80 qemu-aarch64-static -L /usr/aarch64-linux-gnu build/lift-host >/mnt/v/masseffect/me1-sw2/runtime/host/build/test-after.log 2>/mnt/v/masseffect/me1-sw2/runtime/host/build/test-after.err; echo rc=$?'",
    // A heredoc's text mentions paths: it's what goes into the file, not a command.
    "cd /v/masseffect/me1-sw2 && cat >> PROGRESS.md <<'EOF'\n### Notas\n- la captura se guardó en C:/Temp/ y se copió a D:\\backup > E:\\x\nEOF\ngit add PROGRESS.md",
    // robocopy's switches aren't paths; it writes its second argument.
    "robocopy C:\\Users\\halco\\Desktop\\dump V:\\masseffect\\me1-sw2\\dump /E /LOG:'V:\\masseffect\\me1-sw2\\copy.log'",
  ]) assert.equal(held(cmd, tw), null, cmd);
  assert.match(held('robocopy V:\\masseffect\\me1-sw2\\out D:\\backup /E', W), /fuera/);
  assert.match(held("cat > /etc/hosts <<'EOF'\n1.2.3.4 x\nEOF", U), /fuera/);
  assert.match(held("bash -lc 'objdump -d a.elf > /home/u/otro/x.txt'", U), /fuera/);
  assert.equal(normalize('/v/masseffect/me1-sw2', 'win32'), 'v:\\masseffect\\me1-sw2');
});

test('only what cannot be undone is critical: the rest can be approved by the orchestrator', () => {
  const crit = (cmd) => checkCommand(cmd, W)?.critical;
  assert.equal(crit('rm -rf build'), true);
  assert.equal(crit('git reset --hard'), true);
  assert.equal(crit('Remove-Item I:\\recuvaV\\x.txt'), true);
  assert.equal(crit('rm $TARGET/file'), true);
  assert.equal(crit('Remove-Item V:\\'), true);
  assert.equal(crit('format D: /q'), true);
  assert.equal(crit('Copy-Item out\\a.bin D:\\backup\\a.bin'), false);
  assert.equal(crit('Move-Item V:\\masseffect\\me1-sw2\\dist D:\\backup'), false);
  assert.equal(crit('echo x > D:\\notes.txt'), false);
  assert.equal(checkRequest({ toolName: 'Write', input: { file_path: 'D:\\otra\\x.c' } }, W).critical, undefined);
});

test('relative paths are judged from where the command\'s own cd left it', () => {
  // TORRE: «borra fuera de la carpeta del proyecto (../padfix8-build.log)», but it was out/padfix8-build.log.
  assert.equal(held("cd /v/masseffect/me1-sw2/out/scan; wsl -e bash -lc \"ps -ef | grep -c '[b]uild_padfix8'\"; rm -f ../padfix8-build.log; nohup wsl -e bash build_padfix8.sh >/dev/null 2>&1 & echo started"), null);
  assert.equal(held('cd out\\scan && Remove-Item ..\\old.log'), null);
  assert.equal(held('Set-Location -LiteralPath "V:\\masseffect\\me1-sw2\\out"; del ..\\notes.txt'), null);
  assert.equal(held('cd /mnt/v/masseffect/me1-sw2/out/scan && rm ../x.log'), null);
  // Still out of the project once you follow the cd.
  assert.match(held('cd /v/masseffect/me1-sw2/out && rm -f ../../other.log'), /borra fuera de la carpeta del proyecto/);
  assert.match(held('cd V:\\masseffect && rm notes.txt ..\\x.txt'), /fuera de la carpeta/);
  // A wrapper's cd stays inside it; a folder that can't be known keeps the one before.
  assert.match(held("bash -c 'cd /v/masseffect/me1-sw2/out/scan'; rm ../x.log"), /fuera de la carpeta/);
  assert.equal(held("bash -lc 'cd out/scan && rm ../x.log'"), null);
  assert.match(held('cd $BUILD; rm ../x.log'), /fuera de la carpeta/);
  assert.equal(held('cd /home/u/proj/a/b && rm ../c.txt', U), null);
  assert.match(held('cd /home/u/proj && rm ../c.txt', U), /fuera de la carpeta/);
});

test('only disks and a forced push are yours alone; other deletions can go to the orchestrator', () => {
  const only = (cmd) => checkCommand(cmd, W)?.userOnly ?? false;
  assert.equal(only('rm -rf build'), false);
  assert.equal(only('git reset --hard HEAD~1'), false);
  assert.equal(only('Remove-Item -Recurse C:\\otro'), false);
  assert.equal(only('format D:'), true);
  assert.equal(only('git push --force origin master'), true);
  assert.equal(only('rm -rf V:\\'), true);
});

test("a team's work folders: writing there goes on; deleting one whole, or /, is only yours", async () => {
  const { workDir } = await import('../lib/guard.mjs');
  const T = { ...W, roots: [...W.roots, '/home/icasula'] };
  assert.equal(held('wsl -e bash -lc "python3 x.py > /home/icasula/e4/out.log 2>&1"', T), null);
  assert.match(held('wsl -e bash -lc "python3 x.py > /home/otro/out.log 2>&1"', T), /fuera de la carpeta/);
  assert.match(held('wsl -e bash -lc "cd /home/icasula/e4 && rm -rf build"', T), /^borrado recursivo \(rm -r\)$/);
  for (const cmd of ['wsl -e rm -rf /home/icasula', 'wsl -e rm -rf /home', 'Remove-Item -Recurse V:\\masseffect\\me1-sw2', 'bash -c "rm -rf /"']) {
    assert.equal(checkCommand(cmd, T)?.userOnly, true, cmd);
  }
  for (const ok of ['/home/icasula', '/mnt/v/masseffect/x', 'V:\\masseffect']) assert.equal(workDir(ok), ok);
  for (const bad of ['/', '/home', '/mnt/v', 'V:\\', '~/x', 'build', '/home/icasula/../..']) assert.equal(workDir(bad), null, bad);
});

test('--force-with-lease of its own work branch goes to the orchestrator; plain force, main or integration only to you', () => {
  const lease = checkCommand('wsl -e bash -lc "cd /home/icasula/e4 && git commit --amend --no-edit && git push --force-with-lease origin e4/t8b && git status --short"', W);
  assert.equal(lease.reason, 'git push --force-with-lease a una rama de trabajo');
  assert.equal(lease.userOnly, undefined);
  for (const cmd of ['git push --force-with-lease origin integration/me1', 'git push --force-with-lease origin main', 'git push --force-with-lease', 'git push --force origin e4/x', 'git push -f origin e4/x', 'git push --force-with-lease origin +e4/x']) {
    assert.equal(checkCommand(cmd, W)?.userOnly, true, cmd);
  }
});

test('quoted text is no redirect: a perl substitution with «<algorithm>/#include» writes nothing at /#include', () => {
  assert.equal(held(`wsl -e bash -lc "cd /tmp/x; perl -0pi -e 's/#include <algorithm>/#include <new>/' scripts/x.py; git diff --stat"`), null);
  assert.match(held('echo hola > "C:\\Users\\x\\a.txt"'), /fuera de la carpeta/);
});

test("the user's mailbox to the orchestrator: an agent may read it, not write in it", async () => {
  const { checkRequest } = await import('../lib/guard.mjs');
  const roots = ['/p'];
  assert.equal(checkRequest({ toolName: 'Write', input: { file_path: '/p/.relevo/al-orquestador/nota.md' } }, { roots, cwd: '/p', platform: 'linux' })?.mailbox, true);
  assert.equal(checkRequest({ toolName: 'Bash', input: { command: "printf 'T96 E3: coordinad QEMU' > /p/.relevo/al-orquestador/e3.txt" } }, { roots, cwd: '/p', platform: 'linux' })?.mailbox, true);
  assert.equal(checkRequest({ toolName: 'Bash', input: { command: 'ls /p/.relevo/al-orquestador' } }, { roots, cwd: '/p', platform: 'linux' }), null);
  assert.equal(checkRequest({ toolName: 'Write', input: { file_path: '/p/docs/x.md' } }, { roots, cwd: '/p', platform: 'linux' }), null);
});
