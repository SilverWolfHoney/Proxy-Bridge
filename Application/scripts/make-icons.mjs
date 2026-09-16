/**
 * 生成应用图标（exe / 窗口 / 托盘）。
 *
 * 用法：
 *   npm run icon
 *
 * 源图放在仓库根目录的 ico/ 下：
 *   ico/emote_*.png  —— 细节完整的角色图（建议 256 以上），用于 exe 与窗口图标
 *   ico/tab_*.png    —— 同一角色的简化版（64 左右），用于托盘
 *
 * 为什么不复用同一张图：托盘实际只有 16~32 像素，
 * 细节太多的图缩下去会糊成色块；简化版在小尺寸下辨识度高得多。
 *
 * 产物写到 Application/resources/：
 *   app.ico     多尺寸 ICO（16/32/48/64/128/256），exe 与安装包用
 *   app.png     256 尺寸，窗口图标用
 *   tray-32.png 托盘图标（开关两种状态共用同一张，不随状态变色）
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, nativeImage } from 'electron';

const ROOT = path.join(import.meta.dirname, '..');
const ICO_DIR = path.join(ROOT, '..', 'ico');
const OUT_DIR = path.join(ROOT, 'resources');

/** 在 ico/ 下找第一个匹配 prefix 的 png */
function findSource(prefix) {
  if (!fs.existsSync(ICO_DIR)) {
    throw new Error(`找不到源图目录：${ICO_DIR}`);
  }
  const hit = fs
    .readdirSync(ICO_DIR)
    .filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.png'))
    .sort()[0];
  if (!hit) throw new Error(`ico/ 下找不到以 ${prefix} 开头的 png`);
  return path.join(ICO_DIR, hit);
}

/**
 * 取出非预乘的 RGBA 像素。
 *
 * nativeImage.toBitmap() 给的是预乘 alpha 的 BGRA；直接拿去缩放，
 * 透明边缘会因为乘过 alpha 而发暗发糊，所以这里先还原。
 */
function readRgba(img) {
  const { width, height } = img.getSize();
  const bgra = img.toBitmap();
  const rgba = Buffer.alloc(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3];
    if (a === 0) continue;
    rgba[i] = Math.min(255, Math.round((bgra[i + 2] * 255) / a));
    rgba[i + 1] = Math.min(255, Math.round((bgra[i + 1] * 255) / a));
    rgba[i + 2] = Math.min(255, Math.round((bgra[i] * 255) / a));
    rgba[i + 3] = a;
  }
  return { width, height, data: rgba };
}

/** RGBA → nativeImage（写回时再乘上 alpha） */
function toImage(rgba, width, height) {
  const bgra = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    bgra[i] = Math.round((rgba[i + 2] * a) / 255);
    bgra[i + 1] = Math.round((rgba[i + 1] * a) / 255);
    bgra[i + 2] = Math.round((rgba[i] * a) / 255);
    bgra[i + 3] = a;
  }
  return nativeImage.createFromBitmap(bgra, { width, height });
}

/** 双线性缩放（按预乘方式插值，避免透明边缘出黑边） */
function resize(rgba, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const fy = ((y + 0.5) * sh) / dh - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
      const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
      const tx = Math.max(0, Math.min(1, fx - x0));
      const ty = Math.max(0, Math.min(1, fy - y0));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [px, py, w] of [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x1, y0, tx * (1 - ty)],
        [x0, y1, (1 - tx) * ty],
        [x1, y1, tx * ty],
      ]) {
        const i = (py * sw + px) * 4;
        const pa = rgba[i + 3] / 255;
        r += rgba[i] * pa * w;
        g += rgba[i + 1] * pa * w;
        b += rgba[i + 2] * pa * w;
        a += pa * w;
      }
      const i = (y * dw + x) * 4;
      if (a > 0) {
        dst[i] = Math.round(r / a);
        dst[i + 1] = Math.round(g / a);
        dst[i + 2] = Math.round(b / a);
        dst[i + 3] = Math.round(a * 255);
      }
    }
  }
  return dst;
}

/** 把多张 PNG 装进 ICO 容器 */
function buildIco(sizes, pngBlobs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(pngBlobs.length, 4);

  const entries = [];
  let offset = 6 + pngBlobs.length * 16;
  pngBlobs.forEach((png, i) => {
    const size = sizes[i];
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // 色彩平面
    e.writeUInt16LE(32, 6); // 位深
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  });

  return Buffer.concat([header, ...entries, ...pngBlobs]);
}

app.whenReady().then(() => {
  const bigPath = findSource('emote');
  const smallPath = findSource('tab');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* ---------- exe / 窗口图标：用细节完整的图 ---------- */
  const bigImg = nativeImage.createFromPath(bigPath);
  const bigSize = bigImg.getSize();
  if (bigSize.width < 256) {
    console.warn(`  ! 源图只有 ${bigSize.width}px，exe 的大尺寸图标会偏软`);
  }
  const big = readRgba(bigImg);
  console.log(`exe 图标源：${path.basename(bigPath)}（${bigSize.width}x${bigSize.height}）`);

  const icoSizes = [16, 32, 48, 64, 128, 256];
  const blobs = icoSizes.map((s) => toImage(resize(big.data, big.width, big.height, s, s), s, s).toPNG());

  const ico = buildIco(icoSizes, blobs);
  fs.writeFileSync(path.join(OUT_DIR, 'app.ico'), ico);
  console.log(`  → app.ico（${icoSizes.join('/')}，${(ico.length / 1024).toFixed(0)} KB）`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'app.png'),
    toImage(resize(big.data, big.width, big.height, 256, 256), 256, 256).toPNG(),
  );
  console.log('  → app.png（256x256）');

  /* ---------- 托盘图标：用简化版的小图 ---------- */
  const smallImg = nativeImage.createFromPath(smallPath);
  const smallSize = smallImg.getSize();
  const small = readRgba(smallImg);
  console.log(`托盘图标源：${path.basename(smallPath)}（${smallSize.width}x${smallSize.height}）`);

  // 固定出 32px：Windows 会按 DPI 自行缩放，比从 16px 放大清晰
  const TRAY = 32;
  const tray = resize(small.data, small.width, small.height, TRAY, TRAY);

  // 只出一张图，开启与关闭共用。
  // 曾经给「已开启」加过一层整体偏绿滤镜做状态区分，结果把角色的白色衣服、
  // 米色细节一起染绿了；角色本来就是绿发，再叠绿既没区分度又丢细节。
  // 开关状态改由悬停提示和弹窗呈现，图标保持原色。
  fs.writeFileSync(path.join(OUT_DIR, 'tray-32.png'), toImage(tray, TRAY, TRAY).toPNG());
  console.log('  → tray-32.png');

  // 清掉不再使用或已被取代的图标，避免打包进去
  for (const stale of [
    'tray-off.png',
    'tray-on.png',
    'tray-off-32.png',
    'tray-on-32.png',
    'icon.ico',
    'icon.png',
  ]) {
    const p = path.join(OUT_DIR, stale);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`  → 已移除 ${stale}`);
    }
  }

  console.log('\n图标生成完成。');
  app.exit(0);
});
