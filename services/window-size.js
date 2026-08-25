"use strict";

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 680;
// Keep the desktop conversation sidebar above its compact-layout breakpoint.
const PREFERRED_MIN_WIDTH = 960;
const PREFERRED_MIN_HEIGHT = 580;
const ABSOLUTE_MIN_WIDTH = 480;
const ABSOLUTE_MIN_HEIGHT = 420;

function positiveInteger(value, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function mainWindowBoundsForDisplay(display = {}) {
  const workArea = display.workArea || display.bounds || {};
  const areaWidth = positiveInteger(workArea.width, DEFAULT_WIDTH);
  const areaHeight = positiveInteger(workArea.height, DEFAULT_HEIGHT);
  const areaX = Math.round(Number(workArea.x) || 0);
  const areaY = Math.round(Number(workArea.y) || 0);

  const minWidth = Math.min(PREFERRED_MIN_WIDTH, Math.max(ABSOLUTE_MIN_WIDTH, areaWidth - 32));
  const minHeight = Math.min(PREFERRED_MIN_HEIGHT, Math.max(ABSOLUTE_MIN_HEIGHT, areaHeight - 32));
  const horizontalInset = Math.max(32, Math.min(120, Math.round(areaWidth * 0.08)));
  const verticalInset = Math.max(24, Math.min(72, Math.round(areaHeight * 0.06)));
  const normalMaxWidth = Math.max(minWidth, areaWidth - horizontalInset * 2);
  const normalMaxHeight = Math.max(minHeight, areaHeight - verticalInset * 2);
  const width = Math.max(minWidth, Math.min(DEFAULT_WIDTH, Math.round(areaWidth * 0.82), normalMaxWidth));
  const height = Math.max(minHeight, Math.min(DEFAULT_HEIGHT, Math.round(areaHeight * 0.84), normalMaxHeight));

  return {
    width,
    height,
    minWidth,
    minHeight,
    x: areaX + Math.round((areaWidth - width) / 2),
    y: areaY + Math.round((areaHeight - height) / 2)
  };
}

module.exports = { mainWindowBoundsForDisplay };
