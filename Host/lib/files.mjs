// Folders and images on the host, for clients that aren't on the same machine: browsing to pick a project
// folder, and the images a thread mentions (the Mac's `fetchImage`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWindows } from './platform.mjs';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const MAX_IMAGE = 12 << 20;

/** Where browsing starts: drives on Windows, / and the home folder elsewhere. */
export function roots() {
  if (isWindows) {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      try { fs.accessSync(d); drives.push(d); } catch {}
    }
    return [os.homedir(), ...drives];
  }
  return [os.homedir(), '/'];
}

/** The subfolders of `dir` (hidden ones left out), each marked when it's a git repository. */
export function listDirectory(dir) {
  const target = path.resolve(dir || os.homedir());
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const folders = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'node_modules') continue;
    const p = path.join(target, e.name);
    let git = false;
    try { git = fs.existsSync(path.join(p, '.git')); } catch {}
    folders.push({ name: e.name, path: p, git });
    if (folders.length >= 1000) break;
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, folders, roots: roots(), separator: path.sep };
}

export const isImagePath = (p) => IMAGE.test(String(p ?? ''));

/**
 * An image the thread mentions, read from the project (relative paths) or an absolute path the thread
 * names. Only images, and only paths that appear in the thread's text, as on the Mac.
 */
export function readThreadImage(thread, requested) {
  if (!isImagePath(requested)) throw new Error('Solo se pueden ver imágenes');
  const mentioned = thread.items.some((i) => (i.text ?? '').includes(requested) || (i.output ?? '').includes(requested) || (i.title ?? '').includes(requested));
  if (!mentioned) throw new Error('Esa imagen no aparece en este hilo');
  const file = path.isAbsolute(requested) ? requested : path.resolve(thread.projectPath, requested);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('No es un fichero');
  if (st.size > MAX_IMAGE) throw new Error('La imagen es demasiado grande (más de 12 MB)');
  return fs.readFileSync(file);
}
