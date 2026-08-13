/**
 * Minimal ZIP writer, the counterpart to unzip.js.
 *
 * Exists so the CSV export can ship Habits.csv alongside Checkmarks.csv, in
 * the same archive shape Loop itself produces. That companion file is not
 * decoration: without it a re-import has no habit types, and a measurable
 * habit's value of 3 is indistinguishable from Loop's SKIP sentinel.
 *
 * Entries are stored uncompressed (method 0). CSV compresses well, but adding
 * deflate here would buy a smaller download in exchange for a second code
 * path to get wrong; the archives are a few hundred KB at worst.
 */

import { crc32 } from 'node:zlib';

const LFH_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * DOS date/time, which is what the ZIP format stores.
 * @param {Date} date
 */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{name: string, data: Buffer|string}>} files
 * @param {Date} [modified] timestamp stamped on every entry
 * @returns {Buffer}
 */
export function zip(files, modified = new Date()) {
  const { time, day } = dosDateTime(modified);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const sum = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4);        // version needed
    lfh.writeUInt16LE(0, 6);         // flags
    lfh.writeUInt16LE(0, 8);         // method: stored
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(day, 12);
    lfh.writeUInt32LE(sum, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);        // extra field length

    chunks.push(lfh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CD_SIG, 0);
    cd.writeUInt16LE(20, 4);         // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);         // extra
    cd.writeUInt16LE(0, 32);         // comment
    cd.writeUInt16LE(0, 34);         // disk number
    cd.writeUInt16LE(0, 36);         // internal attrs
    cd.writeUInt32LE(0, 38);         // external attrs
    cd.writeUInt32LE(offset, 42);    // offset of local header

    central.push(cd, name);
    offset += lfh.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);              // disk number
  eocd.writeUInt16LE(0, 6);              // disk with central directory
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);             // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}
