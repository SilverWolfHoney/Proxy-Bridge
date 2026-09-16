/**
 * 托盘图标生成器。
 *
 * 图标不是二进制资源，而是用这个脚本生成的：手工拼一个合法的 PNG，
 * 只依赖 Node 内置的 zlib，不引入任何三方库。
 *
 * 图形：白色圆角方块 + 向上的箭头（表示流量经由本机转发出去）。
 * 箭头的颜色用来表示全局代理状态 —— 灰=关闭，绿=已开启。
 *
 * 用法：
 *   node scripts/make-tray-icon.mjs gray  tray-off.png
 *   node scripts/make-tray-icon.mjs green tray-on.png
 *
 * 改完图标记得重新执行一次，产物写到 Application/resources/。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIZE = 64;
const OUT_DIR = path.join(import.meta.dirname, '..', 'resources');

/** CRC32（PNG 每个 chunk 都要） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/* ---------- 画图 ---------- */

const px = Buffer.alloc(SIZE * SIZE * 4); // RGBA

/** 覆盖式画点（alpha 混合） */
function blend(x, y, [r, g, b], a = 1) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const dstA = px[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  px[i] = Math.round((r * a + px[i] * dstA * (1 - a)) / outA);
  px[i + 1] = Math.round((g * a + px[i + 1] * dstA * (1 - a)) / outA);
  px[i + 2] = Math.round((b * a + px[i + 2] * dstA * (1 - a)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

/** 超采样：每个像素取 3x3 子样本求平均，得到抗锯齿边缘 */
function shade(x, y, test, color) {
  let hit = 0;
  const N = 3;
  for (let sy = 0; sy < N; sy += 1) {
    for (let sx = 0; sx < N; sx += 1) {
      const fx = x + (sx + 0.5) / N;
      const fy = y + (sy + 0.5) / N;
      if (test(fx, fy)) hit += 1;
    }
  }
  if (hit > 0) blend(x, y, color, hit / (N * N));
}

const WHITE = [255, 255, 255];
const COLORS = {
  blue: [43, 108, 226], // 默认，与界面强调色同色系
  gray: [148, 163, 184], // 全局代理未开启
  green: [34, 197, 94], // 全局代理已开启
};

const arrowColor = COLORS[process.argv[2]] ?? COLORS.blue;
const outName = process.argv[3] ?? 'tray.png';
const outFile = path.join(OUT_DIR, outName);

// 圆角方块：半径 13，留 2px 边距
const M = 2;
const R = 13;
const inRounded = (x, y) => {
  const x0 = M;
  const y0 = M;
  const x1 = SIZE - M;
  const y1 = SIZE - M;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + R), x1 - R);
  const cy = Math.min(Math.max(y, y0 + R), y1 - R);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= R * R;
};

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    shade(x, y, inRounded, WHITE);
  }
}

// 向上箭头：三角头 + 竖杆
const CX = SIZE / 2;
const STEM_HALF = 3.2;
const STEM_TOP = 24;
const STEM_BOTTOM = 47;
const HEAD_TOP = 15;
const HEAD_HALF = 12;
const HEAD_BOTTOM = 28;

const inArrow = (x, y) => {
  if (y >= STEM_TOP && y <= STEM_BOTTOM && Math.abs(x - CX) <= STEM_HALF) return true;
  if (y >= HEAD_TOP && y <= HEAD_BOTTOM) {
    const t = (y - HEAD_TOP) / (HEAD_BOTTOM - HEAD_TOP);
    if (Math.abs(x - CX) <= HEAD_HALF * (1 - t)) return true;
  }
  return false;
};

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    shade(x, y, inArrow, arrowColor);
  }
}

/* ---------- 编码 PNG ---------- */

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(outFile, png);
console.log(`已生成 ${outFile}（${SIZE}x${SIZE} RGBA，${png.length} 字节，箭头色 ${process.argv[2] ?? 'blue'}）`);
