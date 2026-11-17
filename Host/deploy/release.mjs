#!/usr/bin/env node
// Release assets for the updater, and their signature.
//
//   node Host/deploy/release.mjs build <tag> [outDir]   (CI) relevo-host-<tag>.tar.gz + manifest.json from the tag
//   node Host/deploy/release.mjs sign <tag>             (publisher) checks the GitHub release against the local
//                                                       tag, signs its manifest and uploads manifest.sig (gh)
//   node Host/deploy/release.mjs keygen                 a new signing key (prints the public key for updater.mjs)
//
// The private key stays on the publisher's machine: RELEVO_SIGNING_KEY_FILE, default ~/.relevo/release-signing.pem.
// Installed hosts only install releases whose manifest carries a valid signature.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { filesFromArchive, verifyManifest, assetNames, PROGRAM_FILE, RELEASE_PUBLIC_KEY } from '../lib/updater.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const keyFile = process.env.RELEVO_SIGNING_KEY_FILE ?? path.join(os.homedir(), '.relevo', 'release-signing.pem');
const git = (args, opts = {}) => execFileSync('git', args, { maxBuffer: 64 << 20, ...opts });

/** Program files at `tag`, as the repository has them (Host/…), with their SHA-256. */
function programAt(tag) {
  const names = git(['ls-tree', '-r', '--name-only', tag, 'Host/']).toString().split('\n').filter(Boolean)
    .map((n) => n.slice('Host/'.length)).filter((rel) => PROGRAM_FILE.test(rel));
  return Object.fromEntries(names.map((rel) => [rel, sha256(git(['show', `${tag}:Host/${rel}`]))]));
}

const [command, tag, outArg] = process.argv.slice(2);

if (command === 'build') {
  if (!tag) throw new Error('usage: release.mjs build <tag> [outDir]');
  const out = path.resolve(outArg ?? 'dist');
  fs.mkdirSync(out, { recursive: true });
  const names = assetNames(tag);
  const archivePath = path.join(out, names.archive);
  git(['archive', '--format=tar.gz', `--prefix=relevo-${tag}/`, '-o', archivePath, tag, 'Host']);
  const archive = fs.readFileSync(archivePath);
  const manifest = { tag, archive: sha256(archive), files: programAt(tag) };
  filesFromArchive(archive, manifest); // the archive holds exactly those files
  fs.writeFileSync(path.join(out, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${names.archive} and ${names.manifest} in ${out} (${Object.keys(manifest.files).length} files)`);
} else if (command === 'sign') {
  if (!tag) throw new Error('usage: release.mjs sign <tag>');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-sign-'));
  try {
    const names = assetNames(tag);
    execFileSync('gh', ['release', 'download', tag, '-p', names.manifest, '-p', names.archive, '-D', tmp], { stdio: 'inherit' });
    const manifestBytes = fs.readFileSync(path.join(tmp, names.manifest));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    // What GitHub published must be exactly what this repository has at the tag.
    const local = programAt(tag);
    if (manifest.tag !== tag) throw new Error(`the manifest is for ${manifest.tag}`);
    if (JSON.stringify(Object.entries(local).sort()) !== JSON.stringify(Object.entries(manifest.files).sort())) {
      throw new Error('the release files differ from the local tag: not signing');
    }
    filesFromArchive(fs.readFileSync(path.join(tmp, names.archive)), manifest);
    if (sha256(fs.readFileSync(path.join(tmp, names.archive))) !== manifest.archive) throw new Error('archive checksum mismatch');
    const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
    const signature = crypto.sign(null, manifestBytes, key).toString('base64');
    if (!verifyManifest(manifestBytes, signature, RELEASE_PUBLIC_KEY)) throw new Error('this key is not the one in updater.mjs');
    fs.writeFileSync(path.join(tmp, names.signature), `${signature}\n`);
    execFileSync('gh', ['release', 'upload', tag, path.join(tmp, names.signature), '--clobber'], { stdio: 'inherit' });
    console.log(`Signed ${tag}: installed hosts can update to it now.`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else if (command === 'keygen') {
  if (fs.existsSync(keyFile)) throw new Error(`${keyFile} already exists`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Private key: ${keyFile}\nPublic key for RELEASE_PUBLIC_KEY in Host/lib/updater.mjs:\n${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`);
} else {
  console.error('usage: release.mjs build <tag> [outDir] | sign <tag> | keygen');
  process.exit(2);
}
