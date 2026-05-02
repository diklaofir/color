import { clampInt, getLinePoints } from './geometry.js';

export function rgbKey(r, g, b) {
  return `${r},${g},${b}`;
}

export function buildPaletteLookup(keys) {
  const lookup = new Map();
  keys.forEach((key, index) => {
    lookup.set(key, index);
  });
  return lookup;
}

export function getSelectedLinePoints({
  rangeFromValue,
  rangeToValue,
  perimeterCount,
  perimeterPoints,
  isInsideCircle,
}) {
  const fromIndex = clampInt(rangeFromValue, 1, perimeterCount, 1);
  const toIndex = clampInt(rangeToValue, 1, perimeterCount, perimeterCount);
  const startIndex = Math.min(fromIndex, toIndex);
  const endIndex = Math.max(fromIndex, toIndex);
  const startPoint = perimeterPoints[startIndex - 1];
  const endPoint = perimeterPoints[endIndex - 1];

  if (!startPoint || !endPoint) {
    return [];
  }

  return getLinePoints(startPoint.x, startPoint.y, endPoint.x, endPoint.y).filter((point) =>
    isInsideCircle(point.x, point.y)
  );
}

export function analyzeLinePoints({
  linePoints,
  width,
  imageData,
  whiteData,
  paletteLookup,
  paletteCount,
}) {
  const imageCounts = Array.from({ length: paletteCount }, () => 0);
  const whiteCounts = Array.from({ length: paletteCount }, () => 0);
  let whiteCount = 0;

  for (const point of linePoints) {
    const index = (point.y * width + point.x) * 4;

    if (imageData[index + 3] >= 8) {
      const key = rgbKey(imageData[index], imageData[index + 1], imageData[index + 2]);
      const paletteIndex = paletteLookup.get(key);
      if (paletteIndex !== undefined) {
        imageCounts[paletteIndex] += 1;
      }
    }

    if (whiteData[index + 3] >= 8) {
      const key = rgbKey(whiteData[index], whiteData[index + 1], whiteData[index + 2]);
      const paletteIndex = paletteLookup.get(key);
      if (paletteIndex !== undefined) {
        whiteCounts[paletteIndex] += 1;
      } else if (whiteData[index] === 255 && whiteData[index + 1] === 255 && whiteData[index + 2] === 255) {
        whiteCount += 1;
      }
    } else {
      whiteCount += 1;
    }
  }

  return { imageCounts, whiteCounts, whiteCount };
}

export function getDominantColorIndex(imageCounts) {
  let bestIndex = 0;
  let bestCount = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < imageCounts.length; i += 1) {
    if (imageCounts[i] > bestCount) {
      bestCount = imageCounts[i];
      bestIndex = i;
    }
  }

  return bestIndex;
}

export function extractLinePixels({ linePoints, width, sourceData, targetData }) {
  for (const point of linePoints) {
    const index = (point.y * width + point.x) * 4;
    targetData[index] = sourceData[index];
    targetData[index + 1] = sourceData[index + 1];
    targetData[index + 2] = sourceData[index + 2];
    targetData[index + 3] = sourceData[index + 3];
  }
}

export function paintLinePixels({ linePoints, width, targetData, r, g, b, a = 255 }) {
  for (const point of linePoints) {
    const index = (point.y * width + point.x) * 4;
    targetData[index] = r;
    targetData[index + 1] = g;
    targetData[index + 2] = b;
    targetData[index + 3] = a;
  }
}
