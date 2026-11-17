// Updates from the repository's signed releases (`vX.Y.Z`). Each release carries the program as a tarball, a
// manifest with the SHA-256 of every file and an ed25519 signature of that manifest made with a key that
// never leaves the publisher's machine (Host/deploy/release.mjs). A release is installed only when the
// signature and every file check out; the previous version is kept next to the program, and the supervisor
// puts it back if the new one doesn't start.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { untarGz } from './platform.mjs';

export const DEFAULT_REPO = 'iCasula/Relevo';
/** The release signing key (ed25519, SPKI DER in base64). */
export const RELEASE_PUBLIC_KEY = 'MCowBQYDK2VwAyEACQkvry8VnLmowxMLCgWk54thLcOHp/4OjbKoSCK7T9c=';
const TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
// What makes up the program: entry point, modules, the desktop app's page and the version.
export const PROGRAM_FILE = /^(relevo-host\.mjs|VERSION|lib\/[\w.-]+\.mjs|ui\/[\w.-]+\.(?:html|css|mjs|png|ico|svg|webmanifest))$/;
const ARCHIVE_FILE = /^[^/]+\/Host\/(.+)$/;
export const PENDING_MARKER = '.update-pending';

const parse = (v) => TAG.exec(String(v ?? '').trim())?.slice(1).map(Number) ?? null;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'relevo-host' };

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

export const assetNames = (tag) => ({ archive: `relevo-host-${tag}.tar.gz`, manifest: 'manifest.json', signature: 'manifest.sig' });

/** Whether `signature` (base64) is the release key's signature of `manifest` (bytes). */
export function verifyManifest(manifest, signature, publicKey = RELEASE_PUBLIC_KEY) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, manifest, key, Buffer.from(String(signature).trim(), 'base64'));
  } catch { return false; }
}

/** The newest published, signed release (`vX.Y.Z` with its archive, manifest and signature), or null. */
export async function latestRelease(repo = DEFAULT_REPO) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const releases = (await res.json()).filter((r) => !r.draft && !r.prerelease && parse(r.tag_name)).filter((r) => {
    const names = new Set(r.assets.map((a) => a.name));
    const want = assetNames(r.tag_name);
    return names.has(want.archive) && names.has(want.manifest) && names.has(want.signature);
  });
  return releases.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] ?? null;
}

export async function latestTag(repo = DEFAULT_REPO) {
  return (await latestRelease(repo))?.tag_name ?? null;
}

/** { current, latest, available, checkedAt } — `available` when a signed release is newer than what's installed. */
export async function checkForUpdate({ appDir, repo = DEFAULT_REPO }) {
  const current = installedVersion(appDir);
  const latest = await latestTag(repo);
  const available = !!latest && (!parse(current) || compareVersions(latest, current) > 0);
  return { current, latest, available, checkedAt: Date.now() / 1000 };
}

async function download(url, timeout = 120_000) {
  const res = await fetch(url, { headers: { 'User-Agent': 'relevo-host', Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} (${url.split('/').pop()})`);
  return Buffer.from(await res.arrayBuffer());
}

/** The program's files from a release, checked against its signed manifest: Map(relative path → bytes). */
export async function fetchSignedRelease(tag, repo = DEFAULT_REPO, publicKey = RELEASE_PUBLIC_KEY) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub: no hay release ${tag} (HTTP ${res.status})`);
  const release = await res.json();
  const want = assetNames(release.tag_name);
  const url = (name) => release.assets.find((a) => a.name === name)?.browser_download_url;
  if (!url(want.signature) || !url(want.manifest) || !url(want.archive)) throw new Error(`La versión ${tag} no está firmada: no la instalo`);
  const [manifestBytes, signature] = await Promise.all([download(url(want.manifest)), download(url(want.signature))]);
  if (!verifyManifest(manifestBytes, signature.toString('utf8'), publicKey)) throw new Error(`La firma de ${tag} no es válida: no la instalo`);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.tag !== release.tag_name) throw new Error(`El manifiesto es de ${manifest.tag}, no de ${release.tag_name}`);
  const archive = await download(url(want.archive));
  if (sha256(archive) !== manifest.archive) throw new Error('El paquete descargado no coincide con el manifiesto firmado');
  return { files: filesFromArchive(archive, manifest), version: release.tag_name.replace(/^v/, '') };
}

/** Program files inside a release archive, each checked against the manifest; nothing missing, nothing extra. */
export function filesFromArchive(archive, manifest) {
  const files = new Map();
  for (const [name, data] of untarGz(archive)) {
    const rel = ARCHIVE_FILE.exec(name)?.[1];
    if (!rel || !PROGRAM_FILE.test(rel)) continue;
    if (manifest.files[rel] !== sha256(data)) throw new Error(`${rel} no coincide con el manifiesto firmado`);
    files.set(rel, data);
  }
  for (const rel of Object.keys(manifest.files)) if (!files.has(rel)) throw new Error(`Falta ${rel} en el paquete`);
  if (!files.has('relevo-host.mjs')) throw new Error('relevo-host.mjs no está en el paquete');
  return files;
}

/** The development branch, unsigned: only on explicit request (`relevo-host update main`). */
async function fetchBranch(branch, repo) {
  const archive = await download(`https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`);
  const files = new Map();
  for (const [name, data] of untarGz(archive)) {
    const rel = ARCHIVE_FILE.exec(name)?.[1];
    if (rel && PROGRAM_FILE.test(rel)) files.set(rel, data);
  }
  if (!files.has('relevo-host.mjs')) throw new Error('relevo-host.mjs is not in the archive');
  return { files, version: `${branch} (${new Date().toISOString().slice(0, 10)})` };
}

export const backupDir = (appDir) => `${path.resolve(appDir)}.prev`;

/** Copies the installed program aside, so a version that doesn't start can be put back. */
export function backupProgram(appDir) {
  const dest = backupDir(appDir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['relevo-host.mjs', 'VERSION', 'lib', 'ui']) {
    const src = path.join(appDir, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, name), { recursive: true });
  }
}

/** Puts the copy made before the last update back; true if there was one. */
export function restoreProgram(appDir) {
  const src = backupDir(appDir);
  if (!fs.existsSync(path.join(src, 'relevo-host.mjs'))) return false;
  for (const name of ['lib', 'ui']) fs.rmSync(path.join(appDir, name), { recursive: true, force: true });
  for (const name of ['relevo-host.mjs', 'VERSION', 'lib', 'ui']) {
    if (fs.existsSync(path.join(src, name))) fs.cpSync(path.join(src, name), path.join(appDir, name), { recursive: true });
  }
  fs.rmSync(path.join(appDir, PENDING_MARKER), { force: true });
  return true;
}

/**
 * Installs `ref` (a release tag, or a branch with `allowUnsigned`) into `appDir`: downloads and checks
 * everything first, backs the current version up, then replaces the files. The marker tells the
 * supervisor to put the backup back if the new version keeps failing to start.
 */
export async function installVersion({ appDir, ref, repo = DEFAULT_REPO, allowUnsigned = false }) {
  const isTag = !!parse(ref);
  if (!isTag && !allowUnsigned) throw new Error(`${ref} no es una versión publicada`);
  const { files, version } = isTag ? await fetchSignedRelease(ref, repo) : await fetchBranch(ref, repo);
  const from = installedVersion(appDir);
  backupProgram(appDir);
  for (const dir of ['lib', 'ui']) fs.mkdirSync(path.join(appDir, dir), { recursive: true });
  for (const [rel, data] of files) {
    const dest = path.join(appDir, ...rel.split('/'));
    fs.writeFileSync(`${dest}.new`, data);
    fs.renameSync(`${dest}.new`, dest);
  }
  fs.writeFileSync(path.join(appDir, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(appDir, PENDING_MARKER), JSON.stringify({ from, to: version, at: Date.now() }));
  return { version, files: files.size, from };
}
