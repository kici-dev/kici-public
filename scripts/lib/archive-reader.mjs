/**
 * Read back a standalone package archive: its entry names, and the content of
 * a few named files. `scripts/package.mjs` checks each archive it writes this
 * way, so the check sees the archive a customer downloads, not the directory
 * it was made from.
 *
 * A `.tar.gz` is read with `tar`, which the packaging already needs. A `.zip`
 * is read here, in Node alone, because the hosts that build the Windows light
 * packages need not have Info-ZIP `unzip` (see zip-writer.mjs). The reader
 * handles the classic (non-ZIP64) archives zip-writer.mjs writes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
/** The end record sits in the last 22 bytes plus a comment of at most 65535 bytes. */
const EOCD_MAX_SEARCH = EOCD_MIN_BYTES + 0xffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Entry names without a trailing slash, so a directory and a file name compare alike. */
function entryName(name) {
  return name.replace(/\/$/, '');
}

function readTarGz(archive, want) {
  const listing = execFileSync('tar', ['-tzf', archive], {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const entries = new Set(listing.split('\n').filter(Boolean).map(entryName));
  const present = want(entries).filter((w) => entries.has(w));
  const files = new Map();
  if (present.length === 0) return { entries, files };
  const dest = mkdtempSync(path.join(tmpdir(), 'kici-archive-read-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', dest, ...present], { stdio: 'pipe' });
    for (const name of present) {
      const file = path.join(dest, name);
      if (existsSync(file)) files.set(name, readFileSync(file));
    }
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
  return { entries, files };
}

function readZip(archive, want) {
  const buf = readFileSync(archive);
  let eocd = -1;
  const stop = Math.max(0, buf.length - EOCD_MAX_SEARCH);
  for (let i = buf.length - EOCD_MIN_BYTES; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${archive} is not a zip archive: it has no end record`);
  const count = buf.readUInt16LE(eocd + 10);
  const start = buf.readUInt32LE(eocd + 16);

  /** Entry name → where its central directory record says its data is. */
  const records = new Map();
  let offset = start;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`${archive} is not a zip archive: bad central directory entry ${n}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = entryName(buf.toString('utf-8', offset + 46, offset + 46 + nameLength));
    records.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const entries = new Set(records.keys());
  const files = new Map();
  for (const name of want(entries)) {
    const record = records.get(name);
    if (record === undefined) continue;
    const { method, compressedSize, localOffset } = record;
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`${archive}: the local header of ${name} is missing`);
    }
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === METHOD_DEFLATE) files.set(name, inflateRawSync(data));
    else if (method === METHOD_STORE) files.set(name, Buffer.from(data));
    else throw new Error(`${archive}: ${name} uses compression method ${method}`);
  }
  return { entries, files };
}

/**
 * The entry names of an archive, and the content of each wanted entry it
 * holds. Names are archive paths such as `<dirName>/LICENSE`. `wanted` is a
 * list, or a function that picks the entries to read from the full listing.
 *
 * @param {string} archive
 * @param {'tar.gz' | 'zip'} format
 * @param {string[] | ((entries: Set<string>) => string[])} wanted
 * @returns {{ entries: Set<string>, files: Map<string, Buffer> }}
 */
export function readArchiveFiles(archive, format, wanted) {
  const want = typeof wanted === 'function' ? wanted : () => wanted;
  if (format === 'tar.gz') return readTarGz(archive, want);
  if (format === 'zip') return readZip(archive, want);
  throw new Error(`Unknown archive format: ${format}`);
}
