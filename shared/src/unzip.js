/**
 * Minimal ZIP reader for Loop's CSV export archives.
 *
 * Implemented directly against the PKZIP central-directory format so the app
 * keeps its single-dependency footprint. Supports stored (method 0) and
 * deflated (method 8) entries, which is everything Loop produces.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/**
 * Cap on a single decompressed member. Loop's CSVs are a few hundred KB even
 * for years of history; without this a ~300KB zip bomb can exhaust the heap.
 */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/**
 * Cap on the TOTAL decompressed output of one archive.
 *
 * The per-entry cap alone is not a defence. Central-directory entries carry
 * their own offset, and nothing stops hundreds of them pointing at the SAME
 * local header — so an attacker declares every entry honestly, each one
 * comfortably under MAX_ENTRY_BYTES, and still multiplies the payload
 * arbitrarily. A 41KB archive of 200 entries sharing one 31MB member expanded
 * to 6.05GB in four seconds here, a 153,000x amplification, reachable from
 * an unauthenticated POST /api/import.
 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Cap on how many members we will even attempt. Loop's export contains two.
 * Bounds the work before any decompression happens.
 */
const MAX_ENTRIES = 512;

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} file path within the archive -> contents
 */
export function unzip(buf) {
  const eocd = findEOCD(buf);
  if (eocd === -1) {
    throw Object.assign(new Error('not a zip file: end-of-central-directory not found'), {
      status: 400,
    });
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  // Zip64 archives store 0xffff/0xffffffff here as an escape and keep the real
  // values in a separate record we don't parse. Fail loudly rather than
  // silently importing a truncated subset of the user's history.
  if (entryCount === 0xffff || offset === 0xffffffff) {
    throw Object.assign(new Error('Zip64 archives are not supported'), { status: 400 });
  }

  const files = new Map();
  let totalBytes = 0;

  const tooBig = () => Object.assign(
    new Error('archive expands to too much data'), { status: 400 }
  );

  for (let i = 0; i < Math.min(entryCount, MAX_ENTRIES); i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIG) break;

    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    let compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);

    if (offset + 46 + nameLen > buf.length) break; // truncated central directory
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                    // directory entry
    if (/(^|[\\/])\.\.([\\/]|$)/.test(name)) continue;    // refuse traversal paths
    if (/^([a-zA-Z]:)?[\\/]/.test(name)) continue;        // refuse absolute paths
    if (uncompressedSize > MAX_ENTRY_BYTES) continue;     // declared size too large

    // The local header repeats the name/extra lengths, which may differ from
    // the central directory's, so the data offset must be read from it.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIG) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart > buf.length) continue;

    // Streaming writers set flag bit 3 and leave the sizes zero, deferring them
    // to a data descriptor after the payload. Fall back to the local header,
    // then to "rest of buffer" and let inflate find the end of the stream.
    //
    // Only bit 3 justifies that fallback. A genuinely empty member also has
    // compressedSize 0, and treating it as "size unknown" made it swallow the
    // rest of the archive.
    if (compressedSize === 0 && (flags & 0x08) !== 0) {
      const localCompressed = buf.readUInt32LE(localOffset + 18);
      compressedSize = localCompressed || buf.length - dataStart;
    }

    const end = Math.min(dataStart + compressedSize, buf.length);
    const raw = buf.subarray(dataStart, end);

    // Budget the REMAINING allowance, not the per-entry cap. Without this a
    // member may be individually legal and still blow the total, which is the
    // whole amplification trick — inflate stops at the ceiling rather than
    // materialising gigabytes we would only throw away.
    const remaining = MAX_TOTAL_BYTES - totalBytes;
    if (remaining <= 0) throw tooBig();

    try {
      const out = method === 0
        // Stored entries were previously copied wholesale from
        // `compressedSize`, ignoring the declared size the cap above checks.
        // Truncating here is not enough on its own — the length check below
        // is what actually rejects the archive.
        ? Buffer.from(raw.subarray(0, Math.min(raw.length, remaining + 1)))
        : inflateRawSync(raw, {
            maxOutputLength: Math.min(MAX_ENTRY_BYTES, remaining + 1),
          });

      totalBytes += out.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw tooBig();
      files.set(name, out);
    } catch (err) {
      // An over-budget archive must fail loudly, not be mistaken for a corrupt
      // member. zlib reports the ceiling as ERR_BUFFER_TOO_LARGE, which is
      // indistinguishable from real corruption unless checked by name.
      if (err?.status === 400 || err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw err?.status === 400 ? err : tooBig();
      }
      // A single corrupt member shouldn't abort the whole import.
      continue;
    }
  }

  return files;
}

/** Scan backwards for the end-of-central-directory signature. */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}
