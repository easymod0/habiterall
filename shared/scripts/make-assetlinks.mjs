/**
 * Generate the Digital Asset Links file that verifies an Android app against
 * this origin. Without it a Trusted Web Activity still runs, but Chrome shows
 * a URL bar across the top — the single most common TWA complaint.
 *
 *   node shared/scripts/make-assetlinks.mjs \
 *     --package com.example.habiterall \
 *     --fingerprint AA:BB:CC:...
 *
 * The fingerprint is the SHA-256 of the signing certificate. Get it with:
 *
 *   keytool -list -v -keystore android.keystore -alias habiterall
 *
 * or, if you use Play App Signing, copy it from the Play Console
 * (Setup -> App integrity -> App signing key certificate). That one matters:
 * Google re-signs your upload, so the key that ends up on devices is theirs,
 * not yours.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const pkg = args.get('package');
const fingerprints = (args.get('fingerprint') ?? '')
  .split(',')
  .map((f) => f.trim().toUpperCase())
  .filter(Boolean);

if (!pkg || !fingerprints.length) {
  console.error('usage: make-assetlinks.mjs --package <id> --fingerprint <SHA256[,SHA256...]>');
  console.error('\nPass both the upload key and the Play App Signing key if you use both.');
  process.exit(1);
}

const BAD = fingerprints.filter((f) => !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f));
if (BAD.length) {
  console.error('These do not look like SHA-256 fingerprints (32 colon-separated hex bytes):');
  for (const f of BAD) console.error(`  ${f}`);
  process.exit(1);
}

const links = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: pkg,
    sha256_cert_fingerprints: fingerprints,
  },
}];

// Served from shared/, so both editions expose it automatically.
const outDir = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'public', '.well-known'
);
mkdirSync(outDir, { recursive: true });

const out = join(outDir, 'assetlinks.json');
writeFileSync(out, JSON.stringify(links, null, 2) + '\n');

console.log(`wrote ${out}`);
console.log(`  package     : ${pkg}`);
console.log(`  fingerprints: ${fingerprints.length}`);
console.log('\nVerify once deployed:');
console.log('  curl https://your-domain/.well-known/assetlinks.json');
console.log('\nGoogle caches this. If the app still shows a URL bar, confirm the');
console.log('fingerprint matches the key that actually signed the installed APK.');
