"use strict";

const DOT_BLUE = Object.freeze({ red: 37, green: 99, blue: 235, alpha: 255 });
const DOT_BORDER = Object.freeze({ red: 255, green: 255, blue: 255, alpha: 255 });

function trayBadgeText(count) {
  return Math.max(0, Math.floor(Number(count) || 0)) > 0 ? "unread" : "";
}

function taskStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function isTaskCompletionTransition(previousStatus, nextStatus) {
  const active = new Set(["RUNNING", "EXECUTING", "PLANNING"]);
  const completed = new Set(["DONE", "COMPLETED", "SUCCESS"]);
  return active.has(taskStatus(previousStatus)) && completed.has(taskStatus(nextStatus));
}

function setPixel(bitmap, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  bitmap[offset] = color.blue;
  bitmap[offset + 1] = color.green;
  bitmap[offset + 2] = color.red;
  bitmap[offset + 3] = color.alpha;
}

function paintDot(bitmap, width, height, originX, originY, size = 6) {
  const center = (size - 1) / 2;
  const outerRadius = size / 2;
  const innerRadius = Math.max(1, outerRadius - 1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      if (distance > outerRadius) continue;
      setPixel(bitmap, width, height, originX + x, originY + y, distance <= innerRadius ? DOT_BLUE : DOT_BORDER);
    }
  }
}

function drawTaskCountBadge(sourceBitmap, width, height, count) {
  if (!Buffer.isBuffer(sourceBitmap) || sourceBitmap.length < width * height * 4) return sourceBitmap;
  const bitmap = Buffer.from(sourceBitmap);
  if (!trayBadgeText(count)) return bitmap;
  const size = Math.max(4, Math.min(5, width, height));
  paintDot(bitmap, width, height, Math.max(0, width - size - 2), 2, size);
  return bitmap;
}

function createStandaloneTaskCountBadge(count) {
  if (!trayBadgeText(count)) return null;
  const width = 7;
  const height = 7;
  const bitmap = Buffer.alloc(width * height * 4, 0);
  paintDot(bitmap, width, height, 1, 1, 5);
  return { bitmap, width, height };
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
