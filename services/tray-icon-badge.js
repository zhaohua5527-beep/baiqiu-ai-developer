"use strict";

const GLYPHS = Object.freeze({
  "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"]
});

function trayBadgeText(count) {
  const normalized = Math.max(0, Math.floor(Number(count) || 0));
  if (!normalized) return "";
  return normalized > 99 ? "99+" : String(normalized);
}

function taskStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function isTaskCompletionTransition(previousStatus, nextStatus) {
  const active = new Set(["RUNNING", "EXECUTING", "PLANNING"]);
  const completed = new Set(["DONE", "COMPLETED", "SUCCESS"]);
  return active.has(taskStatus(previousStatus)) && completed.has(taskStatus(nextStatus));
}

function setPixel(bitmap, width, height, x, y, red, green, blue, alpha = 255) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  bitmap[offset] = blue;
  bitmap[offset + 1] = green;
  bitmap[offset + 2] = red;
  bitmap[offset + 3] = alpha;
}

function fillRect(bitmap, width, height, x, y, rectWidth, rectHeight, color) {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let column = x; column < x + rectWidth; column += 1) {
      setPixel(bitmap, width, height, column, row, color.red, color.green, color.blue, color.alpha);
    }
  }
}

function badgeLayout(count) {
  const text = trayBadgeText(count);
  if (!text) return null;
  const scale = 1;
  const glyphWidth = 5 * scale;
  const glyphHeight = 7 * scale;
  const gap = scale;
  const textWidth = text.length * glyphWidth + (text.length - 1) * gap;
  return {
    text,
    scale,
    glyphWidth,
    glyphHeight,
    gap,
    textWidth,
    width: textWidth + 4,
    height: glyphHeight + 4
  };
}

function drawBadge(bitmap, width, height, layout, badgeX, badgeY) {
  const ink = { red: 0, green: 0, blue: 0, alpha: 255 };
  const paper = { red: 255, green: 255, blue: 255, alpha: 255 };

  // Pure black background and one-pixel white strokes keep the badge quiet and crisp.
  fillRect(bitmap, width, height, badgeX + 1, badgeY, Math.max(0, layout.width - 2), layout.height, ink);
  fillRect(bitmap, width, height, badgeX, badgeY + 1, layout.width, Math.max(0, layout.height - 2), ink);

  let cursorX = badgeX + Math.floor((layout.width - layout.textWidth) / 2);
  const cursorY = badgeY + 2;
  for (const character of layout.text) {
    const glyph = GLYPHS[character] || GLYPHS["0"];
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((cell, columnIndex) => {
        if (cell !== "1") return;
        fillRect(
          bitmap,
          width,
          height,
          cursorX + columnIndex * layout.scale,
          cursorY + rowIndex * layout.scale,
          layout.scale,
          layout.scale,
          paper
        );
      });
    });
    cursorX += layout.glyphWidth + layout.gap;
  }
}

function drawTaskCountBadge(sourceBitmap, width, height, count) {
  if (!Buffer.isBuffer(sourceBitmap) || sourceBitmap.length < width * height * 4) return sourceBitmap;
  const layout = badgeLayout(count);
  if (!layout) return Buffer.from(sourceBitmap);

  const bitmap = Buffer.from(sourceBitmap);
  const badgeWidth = Math.min(width, layout.width);
  const badgeHeight = Math.min(height, layout.height);
  const badgeX = Math.max(0, width - layout.width);
  const badgeY = 0;
  drawBadge(bitmap, width, height, { ...layout, width: badgeWidth, height: badgeHeight }, badgeX, badgeY);
  return bitmap;
}

function createStandaloneTaskCountBadge(count) {
  const layout = badgeLayout(count);
  if (!layout) return null;
  const bitmap = Buffer.alloc(layout.width * layout.height * 4, 0);
  drawBadge(bitmap, layout.width, layout.height, layout, 0, 0);
  return { bitmap, width: layout.width, height: layout.height };
}

function pngBufferToIco(png, width, height) {
  if (!Buffer.isBuffer(png) || !png.length) throw new TypeError("PNG buffer is required");
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(width >= 256 ? 0 : width, 6);
  header.writeUInt8(height >= 256 ? 0 : height, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

module.exports = {
  createStandaloneTaskCountBadge,
  drawTaskCountBadge,
  isTaskCompletionTransition,
  pngBufferToIco,
  trayBadgeText
};
