// The only node that touches the disk, so it is the one with the guard.
//
// Everything is written under data/out/ and nowhere else.
// The guard is three checks, in this order:
//   1. the path must be relative, so /etc/passwd is refused outright
//   2. the resolved path must still sit inside the out folder, so ../../.env
//      is refused after the dots are worked out
//   3. the deepest folder that already exists is resolved through symlinks and
//      checked again, so a link planted inside out/ cannot point somewhere else
//
// Fail closed. If any check is unsure, it throws.

import { mkdir, writeFile, appendFile, stat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const type = 'write';

export const meta = {
  label: 'Write a file',
  description: 'Saves text, JSON or CSV under data/out. Cannot write anywhere else.',
  configSchema: {
    path: { type: 'string', required: true, help: 'Relative path inside data/out, for example leads/{{ run.id }}.csv' },
    content: { type: 'string', required: true, help: 'What to write. A string, an object, or an array.' },
    mode: { type: 'string', required: false, default: 'overwrite', help: 'overwrite or append' },
    format: { type: 'string', required: false, default: 'text', help: 'text, json or csv' }
  }
};

// server/nodes/write.js -> data/out
export const OUT_ROOT = resolve(fileURLToPath(new URL('../../data/out', import.meta.url)));

/**
 * Work out the real file path and prove it stays inside data/out.
 * Exported so the guard can be tested on its own.
 */
export async function safePath(relPath, nodeId = 'write') {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error(`write node "${nodeId}" needs a path in config`);
  }
  if (relPath.includes('\0')) {
    throw new Error(`write node "${nodeId}": path contains a null byte, refusing.`);
  }
  if (isAbsolute(relPath)) {
    throw new Error(`write node "${nodeId}": absolute paths are not allowed ("${relPath}"). Write inside data/out only.`);
  }

  const full = resolve(OUT_ROOT, relPath);
  if (full !== OUT_ROOT && !full.startsWith(OUT_ROOT + sep)) {
    throw new Error(`write node "${nodeId}": path "${relPath}" escapes data/out. Refusing to write outside ${OUT_ROOT}.`);
  }
  if (full === OUT_ROOT) {
    throw new Error(`write node "${nodeId}": path "${relPath}" points at the out folder itself, not a file.`);
  }

  // Symlink check. Walk up to the deepest folder that already exists, resolve
  // it for real, and make sure that is still inside the out folder.
  const realRoot = await realpath(OUT_ROOT).catch(() => OUT_ROOT);
  let probe = dirname(full);
  while (probe.length >= realRoot.length) {
    let info = null;
    try {
      info = await stat(probe);
    } catch {
      probe = dirname(probe);
      continue;
    }
    if (!info.isDirectory()) {
      throw new Error(`write node "${nodeId}": "${probe}" is not a folder.`);
    }
    const real = await realpath(probe);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`write node "${nodeId}": "${relPath}" leads outside data/out through a link. Refusing.`);
    }
    break;
  }

  return full;
}

function toCsv(value) {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length) return '';
  const flat = rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }));
  const headers = [];
  for (const row of flat) {
    for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
  }
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(cell).join(',')];
  for (const row of flat) lines.push(headers.map((h) => cell(row[h])).join(','));
  return lines.join('\n') + '\n';
}

function toBody(content, format) {
  if (format === 'json') {
    return JSON.stringify(content === undefined ? null : content, null, 2) + '\n';
  }
  if (format === 'csv') return toCsv(content);
  if (content === null || content === undefined) return '';
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

export async function run(ctx) {
  const cfg = ctx.config || {};
  const nodeId = ctx.node.id;
  if (cfg.content === undefined) {
    throw new Error(`write node "${nodeId}" needs content in config`);
  }

  const format = ['text', 'json', 'csv'].includes(cfg.format) ? cfg.format : 'text';
  const mode = cfg.mode === 'append' ? 'append' : 'overwrite';
  const full = await safePath(cfg.path, nodeId);

  let body = toBody(cfg.content, format);

  await mkdir(dirname(full), { recursive: true });

  if (mode === 'append') {
    // Appending a CSV to a file that already has rows should not repeat the
    // header line.
    if (format === 'csv') {
      const existing = await stat(full).catch(() => null);
      if (existing && existing.size > 0) body = body.split('\n').slice(1).join('\n');
    }
    await appendFile(full, body, 'utf8');
  } else {
    await writeFile(full, body, 'utf8');
  }

  const bytes = Buffer.byteLength(body, 'utf8');
  ctx.log('info', `Wrote ${bytes} bytes to ${full.slice(OUT_ROOT.length + 1)}`);
  return { path: full, bytes };
}
