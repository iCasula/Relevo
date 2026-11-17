// Updates from the repository's release tags (`v1.2.3`): which one is newest, whether it's newer than what is
// installed (<app>/VERSION), and installing it. Only Host/ is downloaded, with no git and no `tar` binary, and
// only into the program's own folder; the service then restarts into the new version.

import fs from 'node:fs';
import path from 'node:path';
import { untarGz } from './platform.mjs';

export const DEFAULT_REPO = 'iCasula/Relevo';
const TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
// What makes up the program: entry point, modules, the desktop app's page and the version.
const WANTED = /^([^/]+)\/Host\/(relevo-host\.mjs|VERSION|lib\/[\w.-]+\.mjs|ui\/[\w.-]+\.(?:html|css|mjs|png|ico|svg|webmanifest))$/;

const parse = (v) => TAG.exec(String(v ?? '').trim())?.slice(1).map(Number) ?? null;

/** >0 when `a` is newer than `b`; versions that aren't x.y.z sort before any that are. */
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function installedVersion(appDir) {
  try { return fs.readFileSync(path.join(appDir, 'VERSION'), 'utf8').trim() || 'dev'; } catch { return 'dev'; }
}

/** The newest `vX.Y.Z` tag on GitHub, or null when the repository has none. */
export async function latestTag(repo = DEFAULT_REPO) {
  const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'relevo-host' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const tags = (await res.json()).map((t) => t.name).filter((n) => parse(n));
  return tags.sort((a, b) => compareVersions(b, a))[0] ?? null;
}

/** { current, latest, available, checkedAt } — `available` when a tag is newer than the installed version. */
export async function checkForUpdate({ appDir, repo = DEFAULT_REPO }) {
  const current = installedVersion(appDir);
  const latest = await latestTag(repo);
  const available = !!latest && (!parse(current) || compareVersions(latest, current) > 0);
  return { current, latest, available, checkedAt: Date.now() / 1000 };
}

/**
 * Installs `ref` (a tag, or `main` for the development branch) into `appDir`. Each file is written next to
 * its target and renamed over it, so a failed download leaves the old version intact.
 */
export async function installVersion({ appDir, ref, repo = DEFAULT_REPO }) {
  const isTag = parse(ref);
  const url = `https://codeload.github.com/${repo}/tar.gz/refs/${isTag ? 'tags' : 'heads'}/${encodeURIComponent(ref)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} (${ref})`);
  const files = [...untarGz(Buffer.from(await res.arrayBuffer()))]
    .map(([name, data]) => [WANTED.exec(name), data]).filter(([m]) => m);
  if (!files.some(([m]) => m[2] === 'relevo-host.mjs')) throw new Error('relevo-host.mjs is not in the archive');
  for (const dir of ['lib', 'ui']) fs.mkdirSync(path.join(appDir, dir), { recursive: true });
  for (const [m, data] of files) {
    const dest = path.join(appDir, ...m[2].split('/'));
    fs.writeFileSync(`${dest}.new`, data);
    fs.renameSync(`${dest}.new`, dest);
  }
  // A tag's own VERSION may lag behind the tag: the tag is what was installed.
  const version = isTag ? ref.replace(/^v/, '') : `${ref} (${new Date().toISOString().slice(0, 10)})`;
  fs.writeFileSync(path.join(appDir, 'VERSION'), `${version}\n`);
  return { version, files: files.length, top: files[0][0][1] };
}
