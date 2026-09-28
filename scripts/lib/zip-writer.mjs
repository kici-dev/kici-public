/**
 * Write a directory tree as a classic (non-ZIP64) zip archive, in Node alone.
 *
 * `scripts/package.mjs` produces the Windows packages as `.zip`, and a build host
 * need not have an Info-ZIP `zip` binary, so the archive is written here: deflate from `node:zlib`, CRC-32 from `zlib.crc32`, and the
 * local headers, central directory and end record laid out by hand.
 *
 * Entry names carry the directory's own name as their first segment
 * (`<dirName>/lib/app.cjs`), the shape `zip -r <out> <dirName>` produces, so
 * extracting the archive recreates `<dirName>/`. Entries are sorted, so the same
 * tree always yields the same entry order. Each entry records its Unix mode, and
 * a file symlink is stored as the bytes it points at; a directory symlink has no
 * zip representation and is refused.
 */
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** The entry count field in the end record is 16 bits wide. */
const MAX_ENTRIES = 0xffff;
/** Sizes and offsets are 32-bit fields; larger archives need ZIP64. */
const MAX_BYTES = 0xffff_ffff;

/** "Made by" Unix (3) at spec version 2.0, so extractors honour the stored mode. */
const VERSION_MADE_BY = (3 << 8) | 20;
/** Spec version 2.0 is the minimum that supports deflate and directories. */
const VERSION_NEEDED = 20;
/** General-purpose flag bit 11: the entry name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** MS-DOS directory attribute, set beside the Unix mode on directory entries. */
const DOS_DIRECTORY = 0x10;

/**
 * Refuse an archive that a classic zip cannot describe.
 *
 * @param {{ entries: number, bytes: number }} size entry count, and the largest
 *   size or offset any header would have to record
 */
export function assertZipLimits({ entries, bytes }) {
  if (entries > MAX_ENTRIES) {
    throw new Error(`zip: ${entries} entries exceed the ${MAX_ENTRIES} entries a zip can list`);
  }
  if (bytes > MAX_BYTES) {
    throw new Error(`zip: an offset or size of ${bytes} bytes exceeds the 4 GiB a zip can record`);
  }
}

/** MS-DOS date and time fields for a timestamp, clamped to the 1980 epoch. */
function dosDateTime(date) {
  if (date.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Every entry under `root/dirName`, directories carrying a trailing slash. */
function collectEntries(root, dirName) {
  const entries = [];
  const walk = (rel) => {
    const full = path.join(root, rel);
    const lst = lstatSync(full);
    const st = lst.isSymbolicLink() ? statSync(full) : lst;
    if (st.isDirectory()) {
      if (lst.isSymbolicLink()) {
        throw new Error(`zip: cannot store the directory symlink ${rel}`);
      }
      entries.push({ name: `${rel.split(path.sep).join('/')}/`, full, st, dir: true });
      for (const child of readdirSync(full)) walk(path.join(rel, child));
    } else if (st.isFile()) {
      entries.push({ name: rel.split(path.sep).join('/'), full, st, dir: false });
    } else {
      throw new Error(`zip: cannot store ${rel}, which is neither a file nor a directory`);
    }
  };
  walk(dirName);
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Archive `root/dirName` into `outputPath`, replacing any file already there.
 *
 * @param {string} root directory that holds `dirName`
 * @param {string} dirName the directory to archive; also each entry's first segment
 * @param {string} outputPath the `.zip` file to write
 */
export function writeZip(root, dirName, outputPath) {
  const entries = collectEntries(root, dirName);
  assertZipLimits({ entries: entries.length, bytes: 0 });

  const fd = openSync(outputPath, 'w');
  try {
    let offset = 0;
    const put = (buf) => {
      writeSync(fd, buf);
      offset += buf.length;
    };
    const central = [];

    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf-8');
      const raw = entry.dir ? Buffer.alloc(0) : readFileSync(entry.full);
      const deflated = raw.length > 0 ? deflateRawSync(raw) : raw;
      const store = deflated.length >= raw.length;
      const data = store ? raw : deflated;
      const method = store ? METHOD_STORE : METHOD_DEFLATE;
      const crc = crc32(raw);
      const { time, date } = dosDateTime(entry.st.mtime);
      assertZipLimits({ entries: entries.length, bytes: offset + raw.length });

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(VERSION_NEEDED, 4);
      local.writeUInt16LE(FLAG_UTF8, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(VERSION_MADE_BY, 4);
      header.writeUInt16LE(VERSION_NEEDED, 6);
      header.writeUInt16LE(FLAG_UTF8, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(data.length, 20);
      header.writeUInt32LE(raw.length, 24);
      header.writeUInt16LE(name.length, 28);
      // Extra field, comment, disk number and internal attributes stay zero.
      const external = ((entry.st.mode & 0xffff) << 16) | (entry.dir ? DOS_DIRECTORY : 0);
      header.writeUInt32LE(external >>> 0, 38);
      header.writeUInt32LE(offset, 42);
      central.push(header, name);

      put(local);
      put(name);
      put(data);
    }

    const centralStart = offset;
    for (const buf of central) put(buf);
    const centralSize = offset - centralStart;
    assertZipLimits({ entries: entries.length, bytes: offset });

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    put(end);
  } finally {
    closeSync(fd);
  }
}
