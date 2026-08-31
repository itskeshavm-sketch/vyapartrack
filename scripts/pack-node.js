// Bundles the engine (JS + node_modules + dashboard) into a single zip that the
// Android app extracts at runtime. Run before building the APK:
//   node scripts/pack-node.js
// Output: android/app/src/main/assets/nodejs-project.zip

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');
const OUT = path.join(ASSETS, 'nodejs-project.zip');
const STAGE = path.join(ROOT, 'build', 'nodejs-project');

// what ships inside the zip
const COPY = [
  { src: 'package.json' },
  { src: 'engine.js' },
  { src: '.env', optional: true },
  { src: 'src' },
  { src: 'public' },
  { src: 'node_modules' },
];

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('Staging engine files...');
rm(STAGE);
fs.mkdirSync(STAGE, { recursive: true });
for (const { src, optional } of COPY) {
  const from = path.join(ROOT, src);
  if (!fs.existsSync(from)) {
    if (optional) continue;
    throw new Error(`Missing required path: ${from}`);
  }
  const to = path.join(STAGE, src);
  if (fs.statSync(from).isDirectory()) copyDir(from, to);
  else fs.copyFileSync(from, to);
}

// strip weight we don't need on-device
rm(path.join(STAGE, 'node_modules', '.cache'));
rm(path.join(STAGE, 'node_modules', '.bin'));
function stripTestDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'test' || name === 'tests' || name === '__tests__' || name === 'demo' || name === 'example' || name === 'examples' || name === '.github') {
      rm(path.join(dir, name));
    } else {
      const sub = path.join(dir, name);
      if (fs.statSync(sub).isDirectory()) stripTestDirs(sub);
    }
  }
}
stripTestDirs(path.join(STAGE, 'node_modules'));

// ---- Pure-Node zip writer (no PowerShell, no extra deps) ----
// Produces a standard PKZIP archive (STORE + DEFLATE entries).
function writeZip(outPath, rootDir) {
  const entries = [];
  const queue = ['']; // relative paths under rootDir
  while (queue.length) {
    const rel = queue.shift();
    const abs = path.join(rootDir, rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs)) queue.push(path.posix.join(rel, name));
      continue;
    }
    const data = fs.readFileSync(abs);
    const nameBuf = Buffer.from(rel.replace(/\\/g, '/'), 'utf8');
    // STORE method (no compression). node_modules has thousands of tiny files that
    // deflate slowly; Android's zip extractor also handles STORE instantly.
    const crc = crc32(data);

    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);       // local file header signature
    lfh.writeUInt16LE(20, 4);               // version needed
    lfh.writeUInt16LE(0, 6);                // flags
    lfh.writeUInt16LE(0, 8);                // method = stored
    lfh.writeUInt16LE(0, 10);               // mod time
    lfh.writeUInt16LE(0x21, 12);            // mod date (1980-01-01)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);               // extra len
    nameBuf.copy(lfh, 30);

    entries.push({
      name: rel.replace(/\\/g, '/'),
      lfh,
      body: data,
      method: 0,
      crc,
      size: data.length,
      compressedSize: data.length,
      nameBuf,
      offset: 0, // filled during write
    });
  }

  // Sort entries by name (zip convention) — keeps diffs small and helps debugging.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const buffers = [];
  let offset = 0;
  for (const e of entries) {
    e.offset = offset;
    buffers.push(e.lfh, e.body);
    offset += e.lfh.length + e.body.length;
  }

  // Central directory
  let cdSize = 0;
  const cdChunks = [];
  for (const e of entries) {
    const rec = Buffer.alloc(46 + e.nameBuf.length);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(20, 4);  // version made by
    rec.writeUInt16LE(20, 6);  // version needed
    rec.writeUInt16LE(0, 8);   // flags
    rec.writeUInt16LE(e.method, 10);
    rec.writeUInt16LE(0, 12);
    rec.writeUInt16LE(0x21, 14);
    rec.writeUInt32LE(e.crc, 16);
    rec.writeUInt32LE(e.compressedSize, 20);
    rec.writeUInt32LE(e.size, 24);
    rec.writeUInt16LE(e.nameBuf.length, 28);
    rec.writeUInt16LE(0, 30); // extra len
    rec.writeUInt16LE(0, 32); // comment len
    rec.writeUInt16LE(0, 34); // disk #
    rec.writeUInt16LE(0, 36); // int attrs
    rec.writeUInt32LE(0, 38); // ext attrs
    rec.writeUInt32LE(e.offset, 42);
    e.nameBuf.copy(rec, 46);
    cdChunks.push(rec);
    cdSize += rec.length;
  }
  for (const r of cdChunks) buffers.push(r);

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);  // disk #
  eocd.writeUInt16LE(0, 6);  // disk where cd starts
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  buffers.push(eocd);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat(buffers));
}

// Standard PKZIP CRC32 (polynomial 0xEDB88320)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

fs.mkdirSync(ASSETS, { recursive: true });
rm(OUT);
console.log(`Zipping ${STAGE} -> ${OUT} (pure Node, STORE method)...`);
writeZip(OUT, STAGE);
const mb = (fs.statSync(OUT).size / (1024 * 1024)).toFixed(1);
console.log(`Packed ${OUT} (${mb} MB)`);
