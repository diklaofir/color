import { getLinePoints, isInsideCircle as isInsideCircleGeometry } from './geometry.js';

function clampIndex(value, length) {
  if (length <= 0) {
    return 0;
  }

  return ((value % length) + length) % length;
}

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function pause() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function buildLineKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function getCircularDistance(a, b, length) {
  if (length <= 0) {
    return 0;
  }

  const raw = Math.abs(a - b);
  return Math.min(raw, length - raw);
}

function samplePerimeterPoints(points, requestedCount) {
  if (!points.length) {
    return [];
  }

  const count = Math.max(1, Math.min(requestedCount, points.length));
  if (count === points.length) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }

  const sampled = [];
  const step = points.length / count;
  for (let i = 0; i < count; i += 1) {
    const index = Math.min(points.length - 1, Math.round(i * step));
    sampled.push({ x: points[index].x, y: points[index].y });
  }

  return sampled;
}

function uniquePixels(...arrays) {
  const seen = new Set();
  const pixels = [];
  for (const array of arrays) {
    for (const pixel of array) {
      if (seen.has(pixel)) {
        continue;
      }
      seen.add(pixel);
      pixels.push(pixel);
    }
  }
  return pixels;
}

function insertSorted(array, value) {
  let low = 0;
  let high = array.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if (array[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  if (array[low] !== value) {
    array.splice(low, 0, value);
  }
}

function removeValue(array, value) {
  const index = array.indexOf(value);
  if (index >= 0) {
    array.splice(index, 1);
  }
}

export class ColorPathOptimizer {
  constructor({
    width,
    height,
    targetColors,
    paletteRgb,
    perimeterPoints,
    circle,
    colorCount = 4,
    linesPerColor = 1000,
    nailCount = 256,
    candidateSamples = 12,
    minDistance = 1,
    localSearchRadius = 8,
  }) {
    this.width = width;
    this.height = height;
    this.pixelCount = width * height;
    this.circle = circle;
    this.colorCount = colorCount;
    this.linesPerColor = linesPerColor;
    this.totalLines = colorCount * linesPerColor;
    this.nailCount = Math.max(1, Math.min(nailCount, perimeterPoints.length || nailCount));
    this.candidateSamples = candidateSamples;
    this.minDistance = Math.max(1, Math.min(minDistance, Math.max(1, Math.floor(this.nailCount / 2))));
    this.localSearchRadius = localSearchRadius;
    this.paletteRgb = paletteRgb.slice(0, colorCount).map((rgb) => rgb.slice());
    this.targetColors = targetColors instanceof Int16Array ? targetColors : Int16Array.from(targetColors);
    this.nails = samplePerimeterPoints(perimeterPoints, this.nailCount);
    this.lineCache = new Map();
    this.lineKeyCounts = new Map();
    this.lineKeyById = new Array(this.totalLines).fill(null);
    this.paths = Array.from({ length: colorCount }, () => new Uint16Array(linesPerColor + 1));
    this.lineColorById = new Uint8Array(this.totalLines);
    this.coverage = Array.from({ length: this.pixelCount }, () => []);
    this.currentColors = new Int16Array(this.pixelCount);
    this.currentColors.fill(-1);
    this.currentImageData = new Uint8ClampedArray(this.pixelCount * 4);
    this.comparableCount = 0;
    this.matchedCount = 0;

    for (let pixel = 0; pixel < this.pixelCount; pixel += 1) {
      const targetColor = this.targetColors[pixel];
      const offset = pixel * 4;
      if (targetColor >= 0) {
        this.comparableCount += 1;
        this.currentImageData[offset] = 255;
        this.currentImageData[offset + 1] = 255;
        this.currentImageData[offset + 2] = 255;
        this.currentImageData[offset + 3] = 255;
      } else {
        this.currentImageData[offset + 3] = 0;
      }
    }
  }

  resetSimulation() {
    this.coverage = Array.from({ length: this.pixelCount }, () => []);
    this.currentColors.fill(-1);
    this.matchedCount = 0;
    this.lineKeyCounts.clear();
    this.lineKeyById.fill(null);

    for (let pixel = 0; pixel < this.pixelCount; pixel += 1) {
      const targetColor = this.targetColors[pixel];
      const offset = pixel * 4;
      if (targetColor >= 0) {
        this.currentImageData[offset] = 255;
        this.currentImageData[offset + 1] = 255;
        this.currentImageData[offset + 2] = 255;
        this.currentImageData[offset + 3] = 255;
      } else {
        this.currentImageData[offset] = 0;
        this.currentImageData[offset + 1] = 0;
        this.currentImageData[offset + 2] = 0;
        this.currentImageData[offset + 3] = 0;
      }
    }
  }

  getMatchRatio() {
    return this.comparableCount > 0 ? this.matchedCount / this.comparableCount : 0;
  }

  getCanvasImageData() {
    return this.currentImageData;
  }

  getPaths() {
    return this.paths.map((path) => Array.from(path));
  }

  getHighestRepeatCount() {
    let highestRepeatCount = 0;

    for (const path of this.paths) {
      const counts = new Map();
      let pathHighest = 0;

      for (const nail of path) {
        const nextCount = (counts.get(nail) || 0) + 1;
        counts.set(nail, nextCount);
        pathHighest = Math.max(pathHighest, nextCount - 1);
      }

      highestRepeatCount = Math.max(highestRepeatCount, pathHighest);
    }

    return highestRepeatCount;
  }

  getLineId(roundIndex, colorIndex) {
    return roundIndex * this.colorCount + colorIndex;
  }

  getLineKey(fromIndex, toIndex) {
    return buildLineKey(fromIndex, toIndex);
  }

  getNailDistance(a, b) {
    return getCircularDistance(a, b, this.nailCount);
  }

  isNailCandidateAllowed(fromIndex, candidateIndex) {
    return this.getNailDistance(fromIndex, candidateIndex) >= this.minDistance;
  }

  addLineKey(lineKey) {
    this.lineKeyCounts.set(lineKey, (this.lineKeyCounts.get(lineKey) || 0) + 1);
  }

  removeLineKey(lineKey) {
    const currentCount = this.lineKeyCounts.get(lineKey) || 0;
    if (currentCount <= 1) {
      this.lineKeyCounts.delete(lineKey);
      return;
    }

    this.lineKeyCounts.set(lineKey, currentCount - 1);
  }

  isLineKeyBlocked(lineKey, excludedKeys = []) {
    let excludedCount = 0;
    for (const key of excludedKeys) {
      if (key === lineKey) {
        excludedCount += 1;
      }
    }

    return ((this.lineKeyCounts.get(lineKey) || 0) - excludedCount) > 0;
  }

  getLinePixels(fromIndex, toIndex) {
    const key = this.getLineKey(fromIndex, toIndex);
    const cached = this.lineCache.get(key);
    if (cached) {
      return cached;
    }

    const start = this.nails[fromIndex];
    const end = this.nails[toIndex];
    if (!start || !end) {
      const empty = new Uint32Array(0);
      this.lineCache.set(key, empty);
      return empty;
    }

    const pixels = [];
    for (const point of getLinePoints(start.x, start.y, end.x, end.y)) {
      if (!isInsideCircleGeometry(point.x, point.y, this.width, this.height, this.circle.centerX, this.circle.centerY, this.circle.radius)) {
        continue;
      }

      pixels.push(point.y * this.width + point.x);
    }

    const cachedPixels = Uint32Array.from(pixels);
    this.lineCache.set(key, cachedPixels);
    return cachedPixels;
  }

  scoreLineImmediately(colorIndex, fromIndex, toIndex) {
    const pixels = this.getLinePixels(fromIndex, toIndex);
    let delta = 0;

    for (const pixel of pixels) {
      const targetColor = this.targetColors[pixel];
      if (targetColor < 0) {
        continue;
      }

      const currentColor = this.currentColors[pixel];
      if (currentColor === targetColor && colorIndex !== targetColor) {
        delta -= 1;
      } else if (currentColor !== targetColor && colorIndex === targetColor) {
        delta += 1;
      }
    }

    return { delta, length: pixels.length, score: delta };
  }

  chooseNextNail(colorIndex, fromIndex, previousIndex = -1) {
    let bestCandidate = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let candidate = 0; candidate < this.nailCount; candidate += 1) {
      if (candidate === fromIndex || candidate === previousIndex) {
        continue;
      }

      if (!this.isNailCandidateAllowed(fromIndex, candidate)) {
        continue;
      }

      const lineKey = this.getLineKey(fromIndex, candidate);
      if (this.isLineKeyBlocked(lineKey)) {
        continue;
      }

      const stats = this.scoreLineImmediately(colorIndex, fromIndex, candidate);
      if (stats.score > bestScore) {
        bestScore = stats.score;
        bestCandidate = candidate;
      }
    }

    return bestCandidate;
  }

  commitLine(roundIndex, colorIndex, fromIndex, toIndex) {
    const lineId = this.getLineId(roundIndex, colorIndex);
    this.lineColorById[lineId] = colorIndex;
    const lineKey = this.getLineKey(fromIndex, toIndex);
    this.lineKeyById[lineId] = lineKey;
    this.addLineKey(lineKey);
    const pixels = this.getLinePixels(fromIndex, toIndex);
    const color = this.paletteRgb[colorIndex] || [255, 255, 255];

    for (const pixel of pixels) {
      this.coverage[pixel].push(lineId);

      const targetColor = this.targetColors[pixel];
      const currentColor = this.currentColors[pixel];
      if (currentColor === targetColor) {
        this.matchedCount -= 1;
      }

      this.currentColors[pixel] = colorIndex;
      if (colorIndex === targetColor) {
        this.matchedCount += 1;
      }

      const offset = pixel * 4;
      this.currentImageData[offset] = color[0];
      this.currentImageData[offset + 1] = color[1];
      this.currentImageData[offset + 2] = color[2];
      this.currentImageData[offset + 3] = 255;
    }
  }

  async buildInitialPaths({ onProgress, yieldEvery = 1 } = {}) {
    this.resetSimulation();

    for (let colorIndex = 0; colorIndex < this.colorCount; colorIndex += 1) {
      this.paths[colorIndex][0] = randomInt(this.nailCount);
    }

    for (let roundIndex = 0; roundIndex < this.linesPerColor; roundIndex += 1) {
      for (let colorIndex = 0; colorIndex < this.colorCount; colorIndex += 1) {
        const path = this.paths[colorIndex];
        const fromIndex = path[roundIndex];
        const previousIndex = roundIndex > 0 ? path[roundIndex - 1] : -1;
        const toIndex = this.chooseNextNail(colorIndex, fromIndex, previousIndex);
        if (toIndex < 0) {
          throw new Error('No unused next nail available');
        }
        path[roundIndex + 1] = toIndex;
        this.commitLine(roundIndex, colorIndex, fromIndex, toIndex);
      }

      if (onProgress) {
        onProgress({
          phase: 'stage1',
          roundIndex: roundIndex + 1,
          totalRounds: this.linesPerColor,
          matchRatio: this.getMatchRatio(),
        });
      }

      if (yieldEvery > 0 && ((roundIndex + 1) % yieldEvery === 0)) {
        await pause();
      }
    }

    return this.getMatchRatio();
  }

  getPathLineIds(colorIndex, middleIndex) {
    return {
      lineIdA: this.getLineId(middleIndex - 1, colorIndex),
      lineIdB: this.getLineId(middleIndex, colorIndex),
    };
  }

  getLinePixelsForPath(colorIndex, startIndex, endIndex) {
    const path = this.paths[colorIndex];
    return this.getLinePixels(path[startIndex], path[endIndex]);
  }

  applyLineGeometrySwap({
    lineIdA,
    oldPixelsA,
    newPixelsA,
    lineIdB,
    oldPixelsB,
    newPixelsB,
  }) {
    const oldByLine = new Map([
      [lineIdA, oldPixelsA],
      [lineIdB, oldPixelsB],
    ]);
    const newByLine = new Map([
      [lineIdA, newPixelsA],
      [lineIdB, newPixelsB],
    ]);

    for (const [lineId, oldPixels] of oldByLine.entries()) {
      const newPixels = newByLine.get(lineId) || new Uint32Array(0);
      const newSet = new Set(newPixels);
      for (const pixel of oldPixels) {
        if (!newSet.has(pixel)) {
          removeValue(this.coverage[pixel], lineId);
        }
      }
    }

    for (const [lineId, newPixels] of newByLine.entries()) {
      const oldPixels = oldByLine.get(lineId) || new Uint32Array(0);
      const oldSet = new Set(oldPixels);
      for (const pixel of newPixels) {
        if (!oldSet.has(pixel)) {
          insertSorted(this.coverage[pixel], lineId);
        }
      }
    }
  }

  refreshAffectedPixels(affectedPixels) {
    for (const pixel of affectedPixels) {
      const oldColor = this.currentColors[pixel];
      const topStack = this.coverage[pixel];
      const nextColor = topStack.length ? this.lineColorById[topStack[topStack.length - 1]] : -1;
      if (oldColor === nextColor) {
        continue;
      }

      const targetColor = this.targetColors[pixel];
      if (oldColor === targetColor) {
        this.matchedCount -= 1;
      }
      if (nextColor === targetColor) {
        this.matchedCount += 1;
      }

      this.currentColors[pixel] = nextColor;
      const offset = pixel * 4;
      if (nextColor >= 0) {
        const rgb = this.paletteRgb[nextColor] || [255, 255, 255];
        this.currentImageData[offset] = rgb[0];
        this.currentImageData[offset + 1] = rgb[1];
        this.currentImageData[offset + 2] = rgb[2];
        this.currentImageData[offset + 3] = 255;
      } else if (this.targetColors[pixel] >= 0) {
        this.currentImageData[offset] = 255;
        this.currentImageData[offset + 1] = 255;
        this.currentImageData[offset + 2] = 255;
        this.currentImageData[offset + 3] = 255;
      } else {
        this.currentImageData[offset] = 0;
        this.currentImageData[offset + 1] = 0;
        this.currentImageData[offset + 2] = 0;
        this.currentImageData[offset + 3] = 0;
      }
    }
  }

  evaluateMiddleNailChange(colorIndex, middleIndex, candidateNail, commit = false) {
    const path = this.paths[colorIndex];
    if (middleIndex <= 0 || middleIndex >= path.length - 1) {
      return 0;
    }

    const currentNail = path[middleIndex];
    if (candidateNail === currentNail) {
      return 0;
    }
    if (!this.isNailCandidateAllowed(currentNail, candidateNail)) {
      return 0;
    }

    const prevNail = path[middleIndex - 1];
    const nextNail = path[middleIndex + 1];
    const lineIdA = this.getLineId(middleIndex - 1, colorIndex);
    const lineIdB = this.getLineId(middleIndex, colorIndex);
    const oldKeyA = this.getLineKey(prevNail, currentNail);
    const oldKeyB = this.getLineKey(currentNail, nextNail);
    const newKeyA = this.getLineKey(prevNail, candidateNail);
    const newKeyB = this.getLineKey(candidateNail, nextNail);

    if (newKeyA === newKeyB) {
      return 0;
    }

    if (
      this.isLineKeyBlocked(newKeyA, [oldKeyA, oldKeyB]) ||
      this.isLineKeyBlocked(newKeyB, [oldKeyA, oldKeyB])
    ) {
      return 0;
    }

    const oldPixelsA = this.getLinePixels(prevNail, currentNail);
    const newPixelsA = this.getLinePixels(prevNail, candidateNail);
    const oldPixelsB = this.getLinePixels(currentNail, nextNail);
    const newPixelsB = this.getLinePixels(candidateNail, nextNail);

    const affectedPixels = uniquePixels(oldPixelsA, newPixelsA, oldPixelsB, newPixelsB);
    const snapshots = affectedPixels.map((pixel) => ({
      pixel,
      coverage: this.coverage[pixel].slice(),
      color: this.currentColors[pixel],
    }));
    const matchedBefore = this.matchedCount;

    this.applyLineGeometrySwap({
      lineIdA,
      oldPixelsA,
      newPixelsA,
      lineIdB,
      oldPixelsB,
      newPixelsB,
    });

    this.refreshAffectedPixels(affectedPixels);
    const delta = this.matchedCount - matchedBefore;

    if (!commit) {
      for (const snapshot of snapshots) {
        this.coverage[snapshot.pixel] = snapshot.coverage;
        this.currentColors[snapshot.pixel] = snapshot.color;

        const offset = snapshot.pixel * 4;
        const color = snapshot.color;
        if (color >= 0) {
          const rgb = this.paletteRgb[color] || [255, 255, 255];
          this.currentImageData[offset] = rgb[0];
          this.currentImageData[offset + 1] = rgb[1];
          this.currentImageData[offset + 2] = rgb[2];
          this.currentImageData[offset + 3] = 255;
        } else if (this.targetColors[snapshot.pixel] >= 0) {
          this.currentImageData[offset] = 255;
          this.currentImageData[offset + 1] = 255;
          this.currentImageData[offset + 2] = 255;
          this.currentImageData[offset + 3] = 255;
        } else {
          this.currentImageData[offset] = 0;
          this.currentImageData[offset + 1] = 0;
          this.currentImageData[offset + 2] = 0;
          this.currentImageData[offset + 3] = 0;
        }
      }
      this.matchedCount = matchedBefore;
      return delta;
    }

    this.removeLineKey(oldKeyA);
    this.removeLineKey(oldKeyB);
    this.addLineKey(newKeyA);
    this.addLineKey(newKeyB);
    this.lineKeyById[lineIdA] = newKeyA;
    this.lineKeyById[lineIdB] = newKeyB;
    path[middleIndex] = candidateNail;
    return delta;
  }

  findBestMiddleNail(colorIndex, middleIndex) {
    const path = this.paths[colorIndex];
    const currentNail = path[middleIndex];
    let bestCandidate = currentNail;
    let bestDelta = 0;

    const scanDirection = (direction) => {
      let candidate = clampIndex(currentNail + direction, this.nailCount);
      let localBestCandidate = currentNail;
      let localBestDelta = 0;

      for (let step = 0; step < this.localSearchRadius; step += 1) {
        if (!this.isNailCandidateAllowed(currentNail, candidate)) {
          candidate = clampIndex(candidate + direction, this.nailCount);
          continue;
        }

        const delta = this.evaluateMiddleNailChange(colorIndex, middleIndex, candidate, false);
        if (delta > localBestDelta) {
          localBestDelta = delta;
          localBestCandidate = candidate;
          candidate = clampIndex(candidate + direction, this.nailCount);
          continue;
        }
        break;
      }

      if (localBestDelta > bestDelta) {
        bestDelta = localBestDelta;
        bestCandidate = localBestCandidate;
      }
    };

    scanDirection(1);
    scanDirection(-1);

    for (let sample = 0; sample < this.candidateSamples; sample += 1) {
      const randomCandidate = randomInt(this.nailCount);
      if (!this.isNailCandidateAllowed(currentNail, randomCandidate)) {
        continue;
      }

      const randomDelta = this.evaluateMiddleNailChange(colorIndex, middleIndex, randomCandidate, false);
      if (randomDelta > bestDelta) {
        bestDelta = randomDelta;
        bestCandidate = randomCandidate;
      }
    }

    return { bestCandidate, bestDelta };
  }

  refineStep() {
    if (!this.linesPerColor || !this.nailCount || this.linesPerColor < 2) {
      return { changed: false, delta: 0 };
    }

    const colorIndex = randomInt(this.colorCount);
    const middleIndex = 1 + randomInt(Math.max(1, this.linesPerColor - 1));
    const { bestCandidate, bestDelta } = this.findBestMiddleNail(colorIndex, middleIndex);

    if (bestDelta <= 0 || bestCandidate === this.paths[colorIndex][middleIndex]) {
      return { changed: false, delta: 0 };
    }

    const delta = this.evaluateMiddleNailChange(colorIndex, middleIndex, bestCandidate, true);
    return { changed: true, delta };
  }

  async refineMany({ iterations, onProgress, yieldEvery = 20 } = {}) {
    let changedCount = 0;
    let totalDelta = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const result = this.refineStep();
      if (result.changed) {
        changedCount += 1;
        totalDelta += result.delta;
      }

      if (onProgress) {
        onProgress({
          phase: 'stage2',
          iteration: iteration + 1,
          totalIterations: iterations,
          changedCount,
          totalDelta,
          matchRatio: this.getMatchRatio(),
        });
      }

      if (yieldEvery > 0 && ((iteration + 1) % yieldEvery === 0)) {
        await pause();
      }
    }

    return {
      changedCount,
      totalDelta,
      matchRatio: this.getMatchRatio(),
    };
  }
}
