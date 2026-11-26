// The guard: what an agent may do on its own and what waits for you, whatever its permission mode.
//
// With «Acceso total» the agents never ask. The guard keeps that speed for ordinary work (building, editing
// and running things inside the project) and stops what can't be undone:
// - recursive or mass deletions (rm -r, find -delete, del /s, Remove-Item -Recurse, rmdir /s, rimraf…);
// - git commands that throw work away (clean -f, reset --hard, checkout/restore of everything, push --force…);
// - formatting disks;
// - deleting, moving or writing outside the project folder (its worktrees and the temp folder are fine);
// - deleting through a path held in a variable, which can't be checked before it expands.
// Those come to you as a permission request, with the reason. In a team the orchestrator decides first, deletions
// included: it allows what's clearly disposable, and otherwise tells the agent to find another way or to note it
// for a later clean-up (see Teams.onApproval). Only disks (formatting, a drive's root) and a forced push always
// wait for you (`userOnly`).

import os from 'node:os';
import path from 'node:path';

// Commands are split on these so each part is judged alone ("cd x && rm -rf y").
const SPLIT = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;

/** The command's parts, split on && || ; | and new lines outside quotes (a quoted «bash -c '…'» stays whole). */
function splitCommand(cmd) {
  const out = [];
  let cur = '', quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  // An unclosed quote: split it all the old way, so nothing hides behind it.
  return (quote ? cmd.split(SPLIT) : out).map((p) => p.trim()).filter(Boolean);
}

const DESTRUCTIVE = [
  [/(?:^|[\s(])(?:sudo\s+)?rm\s+(?:[^\s]*\s+)*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'borrado recursivo (rm -r)'],
  [/(?:^|[\s(])find\b.*\s-delete\b/, 'borrado con find -delete'],
  [/(?:^|[\s(])find\b.*-exec\s+rm\b/, 'borrado con find -exec rm'],
  [/(?:^|[\s(])xargs\s+(?:-\S+\s+)*rm\b/, 'borrado masivo con xargs rm'],
  [/(?:^|[\s(])(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\b[^\n]*\s-(?:Recurse|r)\b/i, 'borrado recursivo (Remove-Item -Recurse)'],
  [/(?:^|[\s(&])(?:del|erase)\b[^\n]*\s\/[sS]\b/, 'borrado masivo (del /s)'],
  [/(?:^|[\s(&])(?:rd|rmdir)\b[^\n]*\s\/[sS]\b/, 'borrado de carpetas (rmdir /s)'],
  [/(?:^|[\s(])git\s+clean\b[^\n]*\s-[a-zA-Z]*f/, 'git clean -f (borra lo no versionado)'],
  [/(?:^|[\s(])git\s+reset\b[^\n]*--hard\b/, 'git reset --hard (descarta cambios)'],
  [/(?:^|[\s(])git\s+(?:checkout|restore)\b(?:\s+--?\S+)*\s+(?:--\s+)?\.(?:\s|$)/, 'git checkout/restore . (descarta cambios)'],
  [/(?:^|[\s(])git\s+stash\s+(?:drop|clear)\b/, 'git stash drop/clear'],
  [/(?:^|[\s(])git\s+branch\s+(?:-\S+\s+)*-D\b/, 'git branch -D'],
  [/(?:^|[\s(])git\s+push\b[^\n]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, 'git push --force'],
  [/(?:^|[\s(])(?:format(?:\.com)?\s+[a-zA-Z]:|(?:mkfs\S*|diskpart|Format-Volume|Clear-Disk|Initialize-Disk)\b)/i, 'formateo de disco'],
  [/(?:^|[\s(])robocopy\b[^\n]*\s\/(?:MIR|PURGE)\b/i, 'robocopy /MIR o /PURGE (borra en el destino)'],
  [/shutil\.rmtree|\brimraf\b|fs\.rm(?:Sync)?\([^)]*recursive|Directory\.Delete\([^)]*true/, 'borrado recursivo desde código'],
];

/** What only you decide, even in a team: it reaches beyond the project (a whole disk, a shared remote). */
const USER_ONLY = new Set(['formateo de disco', 'git push --force']);

// Verbs that delete, move or write files: their path arguments must stay inside the allowed folders.
const DELETE_VERB = /^(?:sudo\s+)?(?:rm|rmdir|del|erase|rd|Remove-Item|ri|unlink|shred|truncate)\b/i;
const WRITE_VERB = /^(?:sudo\s+)?(?:mv|move|Move-Item|mi|cp|copy|Copy-Item|cpi|xcopy|robocopy|New-Item|ni|Set-Content|sc|Add-Content|ac|Out-File|tee|mkdir|md|touch|install|ln|rsync|dd|Expand-Archive|tar|unzip|7z|git\s+clone)\b/i;

/** A push with --force-with-lease (and no plain force) of named branches, none of them main or the integration one. */
function leasePush(part) {
  const m = /(?:^|[\s(])git\s+push\b(.*)$/.exec(part);
  if (!m) return false;
  const args = words(m[1]);
  if (!args.some((a) => a === '--force-with-lease' || a.startsWith('--force-with-lease='))) return false;
  if (args.some((a) => a === '--force' || a === '--mirror' || a === '--all' || a === '--delete' || a.startsWith('+') || /^-[a-zA-Z]*[fd]/.test(a))) return false;
  const refs = args.filter((a) => !a.startsWith('-'));
  if (refs.length < 2) return false; // which branch it would rewrite isn't in the command
  return !refs.slice(1).some((r) => /^(?:main|master|integration(?:\/.*)?|HEAD)$/i.test(r.replace(/^.*:/, '').replace(/^refs\/heads\//, '')));
}

/**
 * A folder you allow a team to work in besides the project (e.g. its copies in WSL): absolute, and never a disk's
 * root, /, /mnt, /home or a single top folder. Null if it doesn't qualify.
 */
export function workDir(p) {
  const s = String(p ?? '').trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '');
  if (!s || /[\0\n*?]/.test(s) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s)) return null;
  if (/^[A-Za-z]:[\\/]/.test(s)) return s.split(/[\\/]/).filter(Boolean).length >= 2 ? s : null;
  if (s.startsWith('/')) {
    const seg = s.split('/').filter(Boolean);
    if (seg[0] === 'mnt' && /^[a-z]$/i.test(seg[1] ?? '')) return seg.length >= 3 ? s : null;
    return seg.length >= 2 && !['mnt', 'proc', 'sys', 'dev'].includes(seg[0]) ? s : null;
  }
  return null;
}

/** Paths that look absolute in a command: C:\…, C:/…, /mnt/c/…, /…, ~/… (quotes stripped). */
function absolutePaths(text) {
  const out = [];
  const re = /(?:^|[\s"'=(,])((?:[A-Za-z]:[\\/]|\\\\[^\s"']+|~[\\/]|\/)[^\s"'|;&<>,)]*)/g;
  for (const m of text.matchAll(re)) {
    const p = m[1];
    if (/^\/(?:dev\/null|dev\/std|proc\/|tmp\b)/.test(p) || p === '/') { if (p === '/') out.push(p); continue; }
    out.push(p);
  }
  return out;
}

/** One form for comparing: Windows-style, lower case on Windows; /mnt/v/x → V:\x. */
export function normalize(p, platform = process.platform) {
  let s = String(p ?? '').trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  // A WSL distro's files seen from Windows (\\wsl.localhost\Ubuntu\home\x, \\wsl$\Ubuntu\home\x) are its /home/x.
  const unc = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]+[^\\/]+(?:[\\/](.*))?$/i.exec(s);
  if (unc) s = `/${(unc[1] ?? '').replace(/\\/g, '/')}`;
  // WSL's /mnt/v/x, and on Windows Git Bash's /v/x: both are V:\x.
  const wsl = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(s) ?? (platform === 'win32' ? /^\/([a-zA-Z])(?:\/(.*))?$/.exec(s) : null);
  if (wsl) s = `${wsl[1].toUpperCase()}:\\${(wsl[2] ?? '').replace(/\//g, '\\')}`;
  const windows = platform === 'win32' || /^[A-Za-z]:[\\/]/.test(s);
  if (windows) {
    s = s.replace(/\//g, '\\').replace(/\\+$/, '');
    if (/^[A-Za-z]:$/.test(s)) s += '\\';
    if (!s) s = '\\'; // «/» (a distro's root) stays a root, never «nothing»
    return s.toLowerCase();
  }
  return path.posix.normalize(s).replace(/\/+$/, '') || '/';
}

function inside(p, roots, platform) {
  const n = normalize(p, platform);
  if (!n) return true;
  const sep = n.includes('\\') ? '\\' : '/';
  return roots.some((r) => { const root = normalize(r, platform); return root && (n === root || n.startsWith(root.endsWith(sep) ? root : root + sep)); });
}

/** A path from where the agent runs, resolved the way its own system would. */
function resolveFrom(cwd, p) {
  const win = /^[A-Za-z]:[\\/]/.test(cwd ?? '');
  return win ? path.win32.resolve(cwd, p) : path.posix.resolve(cwd ?? '/', p);
}

/**
 * Where a «cd» (pushd, Set-Location) takes the command, or undefined if the part isn't one. A folder that can't be
 * known before it runs (a variable, «cd -») keeps the one before: relative paths are judged from there, as before.
 */
function changeDir(part, from, platform) {
  const m = /^(?:cd|chdir|pushd|Set-Location|sl)(?:\s+\/d)?(?:\s+-(?:LiteralPath|Path))?\s+("[^"]+"|'[^']+'|[^\s;&|<>]+)\s*$/i.exec(part);
  if (!m) return /^(?:cd|chdir|pushd|Set-Location|sl)\s*$/i.test(part) ? from : undefined;
  const dir = m[1].replace(/^["']|["']$/g, '');
  if (/\$|%\w+%|^-$|^~/.test(dir)) return from;
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(dir)) {
    const n = normalize(dir, platform);
    return /^[a-z]:\\/i.test(n) ? n : dir;   // /v/x on Windows and /mnt/v/x are V:\x
  }
  return from ? resolveFrom(from, dir) : from;
}

/** The arguments of a command, quotes respected. */
function words(text) {
  return [...String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// «/» is a root on Windows too: through WSL it's the whole Linux disk.
const isRoot = (p, platform) => { const n = normalize(p, platform); return /^[a-z]:\\$/.test(n) || n === '/' || /^\/+$/.test(String(p).trim()) || /^\/mnt(?:\/[a-z])?\/?$/.test(String(p).trim()); };

/**
 * The folders an agent may write in by itself: the project, its worktree, the temp folders and Relevo's data
 * (where worktrees live).
 */
export function guardRoots({ projectPath, worktreePath, extra = [] }) {
  return [projectPath, worktreePath, os.tmpdir(), process.env.TEMP, process.env.TMP, '/tmp', ...extra].filter(Boolean);
}

/** Why a shell command must wait for you, or null. `critical`: it can't be undone (only you decide those). */
export function checkCommand(command, { roots = [], cwd = null, platform = process.platform } = {}) {
  // A heredoc's lines are text going into a file, not commands: «cat >> notes.md <<'EOF'» is judged, its body isn't.
  const cmd = String(command ?? '').replace(/<<-?[ \t]*(["']?)([A-Za-z_]\w*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<$1$2$1$3').trim();
  if (!cmd) return null;
  // A wrapper's inner command counts too: bash -lc '…', powershell -Command "…", wsl -- …, cmd /c …
  // Each part is judged from the folder the command's own «cd» left it in (a wrapper's «cd» stays inside it).
  let here = cwd;
  const parts = splitCommand(cmd).flatMap((p) => {
    const inner = /(?:bash|sh|zsh)\s+(?:-\w+\s+)*-\w*c\s+(["'])([\s\S]*)\1/.exec(p) ?? /(?:powershell(?:\.exe)?|pwsh)\b[^"']*?-(?:Command|c)\s+(["'])([\s\S]*)\1/i.exec(p) ?? /cmd(?:\.exe)?\s+\/[cCkK]\s+(["']?)([\s\S]*)\1/.exec(p);
    // The wrapper is judged without the inner command (judged on its own, part by part): a «git push» inside
    // «bash -lc "cd x && git push …"» is read with its own arguments, not with the rest of the line.
    return inner ? [{ raw: p.slice(0, inner.index) + p.slice(inner.index + inner[0].length) }, ...splitCommand(inner[2]).map((x, i) => ({ raw: x, inner: true, first: i === 0 }))] : [{ raw: p }];
  });
  let innerHere = cwd;
  for (const { raw, inner, first } of parts) {
    const part = raw.replace(/^(?:wsl(?:\.exe)?\s+(?:(?:-d|--distribution|-u|--user|--cd)\s+\S+\s+)*(?:-e|--exec)\s+|wsl(?:\.exe)?\s+(?:-\S+\s+(?:\S+\s+)?)*--\s+|sudo\s+|env\s+(?:\S+=\S+\s+)*|exec\s+)/i, '').trim();
    if (inner && first) innerHere = here;
    const from = inner ? innerHere : here;
    const moved = changeDir(part, from, platform);
    if (moved !== undefined) { if (inner) innerHere = moved; else here = moved; continue; }
    // Rewriting a work branch of its own (after an amend) with --force-with-lease: the orchestrator decides it,
    // like a deletion. A plain --force, main or the integration branch still wait for you.
    if (leasePush(part)) return { reason: 'git push --force-with-lease a una rama de trabajo', critical: true };
    for (const [re, why] of DESTRUCTIVE) {
      if (!re.test(part)) continue;
      const paths = absolutePaths(part);
      const root = paths.find((p) => isRoot(p, platform));
      if (root) return { reason: `${why} sobre la raíz de un disco (${root})`, critical: true, userOnly: true };
      // The project or a whole work folder (or what holds them): only you.
      const whole = paths.find((p) => roots.some((r) => inside(r, [p], platform)));
      if (whole) return { reason: `${why} de una carpeta de trabajo entera (${whole})`, critical: true, userOnly: true };
      return { reason: why, critical: true, userOnly: USER_ONLY.has(why) || undefined };
    }
    const deletes = DELETE_VERB.test(part);
    const verb = deletes || WRITE_VERB.test(part);
    // Quoted text is an argument, not a redirect: «perl -pi -e 's/<algorithm>/#include…/'» writes no «/#include».
    const unquoted = part.replace(/(?<!>[ \t]*)("[^"]*"|'[^']*')/g, "''");
    const redirects = [...unquoted.matchAll(/(?:^|[^>&\d])\d?>{1,2}[ \t]*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)].map((m) => m[1].replace(/^["']|["']$/g, ''))
      .filter((p) => /^(?:[A-Za-z]:[\\/]|\/|~)/.test(p) && !/^\/(?:dev\/(?:null|std)|tmp\b)/.test(p));
    if (!verb && !redirects.length) continue;
    if (deletes && /\$\{?\w+|%\w+%|\$\(/.test(part.replace(DELETE_VERB, ''))) return { reason: 'borrado con una ruta en una variable (no se puede comprobar antes)', critical: true };
    // Only a redirect writes («objdump … > /tmp/x»): the program and the files it reads aren't written.
    let checked = verb ? absolutePaths(part) : redirects;
    // A copy only writes its destination (its last argument, or -Destination; robocopy's second); a move also
    // takes away its source. Windows switches (/MIR, /LOG:…) aren't paths.
    if (/^(?:sudo\s+)?(?:cp|copy|Copy-Item|cpi|xcopy|robocopy|install|rsync)\b/i.test(part)) {
      const windows = /^(?:copy|xcopy|robocopy)\b/i.test(part);
      const args = words(part).slice(1).filter((w) => !w.startsWith('-') && !(windows ? /^\/[A-Za-z]+(?::|$)/ : /^\/[A-Z]+$/).test(w));
      const dest = /-Destination\s+("[^"]+"|'[^']+'|\S+)/i.exec(part)?.[1]?.replace(/^["']|["']$/g, '') ?? (/^robocopy\b/i.test(part) ? args[1] : args[args.length - 1]);
      checked = [...(dest && /^(?:[A-Za-z]:[\\/]|\\\\|~|\/)/.test(dest) ? [dest] : []), ...redirects];
    }
    for (const p of checked) {
      if (isRoot(p, platform)) return { reason: `opera sobre la raíz de un disco (${p})`, critical: true, userOnly: true };
      if (!inside(p, roots, platform)) return { reason: `${deletes ? 'borra' : /^(?:mv|move|Move-Item|mi)\b/i.test(part) ? 'mueve' : 'escribe'} fuera de la carpeta del proyecto (${p})`, critical: deletes };
    }
    // ..\..\ out of the project from where it runs.
    if (from && /(?:^|[\s"'])\.\.[\\/]/.test(part)) {
      for (const m of part.matchAll(/(?:^|[\s"'])((?:\.\.[\\/])+[^\s"'|;&<>]*)/g)) {
        const abs = resolveFrom(from, m[1]);
        if (!inside(abs, roots, platform)) return { reason: `${deletes ? 'borra' : 'escribe'} fuera de la carpeta del proyecto (${m[1]})`, critical: deletes };
      }
    }
  }
  return null;
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

/**
 * A permission request from any agent: why it must wait for you, or null if it can go on its own.
 * `req` carries toolName and, when the agent says, the command, the input (Claude, ACP) or the folder a file
 * change wants (Codex's grantRoot).
 */
export function checkRequest(req, { roots, cwd, platform = process.platform } = {}) {
  const input = req.input && typeof req.input === 'object' ? req.input : {};
  const command = req.command ?? input.command ?? (Array.isArray(input) ? null : input.cmd) ?? null;
  const file = input.file_path ?? input.notebook_path ?? input.path ?? null;
  // The user's mailbox to the orchestrator (.relevo/al-orquestador): only the user and their outside auditor
  // write there; an agent that does speaks to the orchestrator as if it were the user.
  const MAILBOX = /\.relevo[\\/]+al-orquestador/i;
  if ((file && MAILBOX.test(String(file)) && (FILE_TOOLS.has(req.toolName) || req.toolName === 'fileChange'))
    || (command && MAILBOX.test(command) && /(^|[^-<>=!])>{1,2}|\b(tee|cp|mv|copy|move|Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|New-Item|rename|ren)\b/i.test(command))) {
    return { reason: 'escribe en el buzón del usuario (.relevo/al-orquestador)', mailbox: true };
  }
  if (command) { const v = checkCommand(command, { roots, cwd, platform }); if (v) return v; }
  if (file && (FILE_TOOLS.has(req.toolName) || req.toolName === 'fileChange' || !command)) {
    const abs = /^(?:[A-Za-z]:[\\/]|\/|~)/.test(file) ? file : cwd ? resolveFrom(cwd, file) : file;
    if (!inside(abs, roots, platform)) return { reason: `${READ_TOOLS.has(req.toolName) ? 'lee' : 'escribe'} fuera de la carpeta del proyecto (${file})` };
  }
  if (req.grantRoot && !inside(req.grantRoot, roots, platform)) return { reason: `quiere escribir fuera de la carpeta del proyecto (${req.grantRoot})` };
  // Agents that only describe what they want (Antigravity, some ACP ones): the text is checked as a command.
  if (!command && !file && req.text) { const v = checkCommand(req.text, { roots, cwd, platform }); if (v) return v; }
  return null;
}
