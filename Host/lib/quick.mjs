// Small one-off completions with a cheap model, for what the Mac does with its "modelo auxiliar": thread
// titles and commit messages. Claude Code (`-p`, Haiku) when signed in; Codex (`exec`) otherwise.

import { spawnCLI, killTree } from './platform.mjs';

const TIMEOUT_MS = 90_000;

function run(bin, args, { env, cwd, input }) {
  return new Promise((resolve, reject) => {
    const p = spawnCLI(bin, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', () => {});
    const timer = setTimeout(() => { killTree(p); reject(new Error('El modelo auxiliar no ha respondido a tiempo')); }, TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error((err || out).trim().slice(-400) || `código ${code}`));
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

/** The first signed-in account able to answer: Claude preferred (Haiku is cheap and quick). */
export async function quickCompletion(accounts, prompt, { env, cwd, fake }) {
  if (fake) return prompt.includes('commit') ? 'Actualiza los ficheros del proyecto' : 'Título de prueba';
  const usable = accounts.filter((a) => a.status?.loggedIn !== false);
  const claude = usable.find((a) => a.provider === 'claude');
  if (claude) return run(claude.bin, ['-p', '--model', 'haiku', '--output-format', 'text'], { env, cwd, input: prompt });
  const codex = usable.find((a) => a.provider === 'codex');
  if (codex) return run(codex.bin, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', prompt], { env, cwd });
  throw new Error('No hay ninguna suscripción con sesión para el modelo auxiliar');
}

export function cleanTitle(text) {
  const line = String(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/^["'«“]+|["'»”.]+$/g, '').replace(/^(t[íi]tulo|title)\s*:\s*/i, '').slice(0, 70);
}
