// Regenerates public/icons/ from icon.svg. Icons are build artifacts, not
// committed (binary-over-MCP is risky); run this after cloning: 
//   npm i -D sharp && node scripts/gen-icons.mjs
import fs from 'node:fs';
let sharp;
try { sharp = (await import('sharp')).default; }
catch { console.error('sharp not installed — run: npm i -D sharp'); process.exit(1); }
fs.mkdirSync('public/icons', { recursive: true });
const svg = fs.readFileSync('icon.svg');
await sharp(svg).resize(192, 192).png().toFile('public/icons/icon-192.png');
await sharp(svg).resize(512, 512).png().toFile('public/icons/icon-512.png');
await sharp(svg).resize(180, 180).flatten({ background: '#0d0f14' }).png().toFile('public/icons/apple-touch-icon.png');
const inner = await sharp(svg).resize(410, 410).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0d0f14' } })
  .composite([{ input: inner, gravity: 'centre' }]).png().toFile('public/icons/icon-512-maskable.png');
console.log('icons written to public/icons/');
