// Renders the tray template icon and the app icon as PNGs without any image dependencies.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => buf.reduce((c, b) => crcTable[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff;
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td) >>> 0);
  return Buffer.concat([len, td, c]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
        for (let i = 0; i < 4; i++) acc[i] += p[i] / 16;
      }
      acc.forEach((v, i) => (raw[y * (size * 4 + 1) + 1 + x * 4 + i] = Math.round(v)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const d = (u, v) => Math.hypot(u - 0.5, v - 0.5);

// Tray: ring with a filled center dot (template image: black + alpha).
const tray = (u, v) => {
  const r = d(u, v);
  const on = (r <= 0.44 && r >= 0.32) || r <= 0.16;
  return [0, 0, 0, on ? 255 : 0];
};
writeFileSync("assets/trayTemplate.png", png(16, tray));
writeFileSync("assets/trayTemplate@2x.png", png(32, tray));

// App icon: brand-purple squircle with a white record dot.
const appIcon = (u, v) => {
  const m = 0.09, x = Math.abs(u - 0.5) / (0.5 - m), y = Math.abs(v - 0.5) / (0.5 - m);
  const inSquircle = Math.pow(x, 5) + Math.pow(y, 5) <= 1;
  if (!inSquircle) return [0, 0, 0, 0];
  const r = d(u, v);
  if (r <= 0.17) return [255, 255, 255, 255];
  if (r <= 0.27 && r >= 0.22) return [255, 255, 255, 110];
  const t = v; // subtle vertical gradient
  return [Math.round(112 - 20 * t), Math.round(106 - 22 * t), 250, 255];
};
const set = "assets/icon.iconset";
rmSync(set, { recursive: true, force: true }); mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) {
  writeFileSync(`${set}/icon_${s}x${s}.png`, png(s, appIcon));
  writeFileSync(`${set}/icon_${s}x${s}@2x.png`, png(s * 2, appIcon));
}
execFileSync("iconutil", ["-c", "icns", set, "-o", "assets/icon.icns"]);
rmSync(set, { recursive: true });
console.log("icons written");
