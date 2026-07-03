// Refreshes the geosite.dat/geoip.dat objects in the R2 bucket from the same
// upstream Xray-core's own install script (XTLS/Xray-install) uses. Run as
// part of `npm run deploy`, before the app is built/deployed.
//
// Keep BUCKET_NAME and the object keys in sync with wrangler.jsonc and
// src/lib/geodata/constants.ts if those ever change.
import { execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUCKET_NAME = 'geodata';

const SOURCES = [
  { url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat', key: 'geosite.dat' },
  { url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat', key: 'geoip.dat' },
];

const tmpDir = await mkdtemp(join(tmpdir(), 'geodata-'));

try {
  for (const { url, key } of SOURCES) {
    console.log(`Fetching ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const filePath = join(tmpDir, key);
    await writeFile(filePath, bytes);

    console.log(`Uploading ${key} (${bytes.length} bytes) to R2 bucket "${BUCKET_NAME}"`);
    execSync(`npx wrangler r2 object put "${BUCKET_NAME}/${key}" --file="${filePath}" --remote`, { stdio: 'inherit' });
  }
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

console.log('geosite.dat and geoip.dat are up to date in R2.');
