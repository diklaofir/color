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

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    if (j === i) {
      continue;
    }

    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
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
    this.nailCount = Math.max(1, Math.min(nailCount, perimeterPoints.length || nailCount));
    this.candidateSamples = candidateSamples;
    this.minDistance = Math.max(1, Math.min(minDistance, Math.max(1, Math.floor(this.nailCount / 2))));
    this.localSearchRadius = localSearchRadius;
    this.paletteRgb = paletteRgb.slice(0, colorCount).map((rgb) => rgb.slice());
    this.targetColors = targetColors instanceof Int16Array ? targetColors : Int16Array.from(targetColors);
    this.nails = samplePerimeterPoints(perimeterPoints, this.nailCount);
    this.lineCache = new Map();
    this.lineKeyCounts = new Map();
    this.lineKeyById = [];
    this.paths = Array.from({ length: colorCount }, () => []);
    this.pathLineIds = Array.from({ length: colorCount }, () => []);
    this.lineColorById = [];
    this.refineSweepOrder = [];
    this.refineSweepIndex = 0;
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
    this.lineKeyById = [];
    this.lineColorById = [];
    this.paths = Array.from({ length: this.colorCount }, () => []);
    this.pathLineIds = Array.from({ length: this.colorCount }, () => []);
    this.refineSweepOrder = [];
    this.refineSweepIndex = 0;

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

  commitLine(colorIndex, fromIndex, toIndex) {
    const lineId = this.lineColorById.length;
    this.lineColorById.push(colorIndex);
    const lineKey = this.getLineKey(fromIndex, toIndex);
    this.lineKeyById.push(lineKey);
    this.addLineKey(lineKey);
    this.pathLineIds[colorIndex].push(lineId);
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

  removeLastLine(colorIndex) {
    const lineId = this.pathLineIds[colorIndex].pop();
    if (lineId === undefined) {
      return;
    }

    const lineKey = this.lineKeyById[lineId];
    const pixels = this.getLinePixelsByLineId(lineId);
    const colorIndexForLine = this.lineColorById[lineId];

    for (const pixel of pixels) {
      removeValue(this.coverage[pixel], lineId);
      const topStack = this.coverage[pixel];
      const nextColor = topStack.length ? this.lineColorById[topStack[topStack.length - 1]] : -1;
      const oldColor = this.currentColors[pixel];
      if (oldColor === this.targetColors[pixel]) {
        this.matchedCount -= 1;
      }
      if (nextColor === this.targetColors[pixel]) {
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

    this.removeLineKey(lineKey);
    this.lineKeyById[lineId] = undefined;
    this.lineColorById[lineId] = undefined;
    void colorIndexForLine;
  }

  getLinePixelsByLineId(lineId) {
    const lineKey = this.lineKeyById[lineId];
    if (!lineKey) {
      return new Uint32Array(0);
    }

    const [fromIndex, toIndex] = lineKey.split(':').map((value) => Number.parseInt(value, 10));
    return this.getLinePixels(fromIndex, toIndex);
  }

  truncateToRounds(roundCount) {
    while (this.paths.length && Math.max(0, this.paths[0].length - 1) > roundCount) {
      for (let colorIndex = 0; colorIndex < this.colorCount; colorIndex += 1) {
        this.removeLastLine(colorIndex);
        if (this.paths[colorIndex].length > 1) {
          this.paths[colorIndex].pop();
        }
      }
    }
  }

  async buildInitialPaths({ onProgress, yieldEvery = 1, maxWorseningRounds = 3 } = {}) {
    return this.buildRounds(Number.POSITIVE_INFINITY, { onProgress, yieldEvery, maxWorseningRounds });
  }

  async buildRounds(roundCount, { onProgress, yieldEvery = 1, maxWorseningRounds = Number.POSITIVE_INFINITY, shouldAbort = null } = {}) {
    for (let colorIndex = 0; colorIndex < this.colorCount; colorIndex += 1) {
      const path = this.paths[colorIndex];
      if (path.length > 0) {
        continue;
      }

      path.push(0);
    }

    const existingRounds = this.paths.reduce((max, path) => Math.max(max, Math.max(0, path.length - 1)), 0);
    let roundsCompleted = existingRounds;
    let bestMatchRatio = this.getMatchRatio();
    let bestRoundsCompleted = roundsCompleted;
    let explorationRemaining = 0;
    let stoppedEarly = false;

    const targetRounds = Number.isFinite(roundCount) ? Math.max(0, roundCount) : Number.POSITIVE_INFINITY;

    while (roundsCompleted - existingRounds < targetRounds) {
      if (shouldAbort && shouldAbort()) {
        throw new Error('aborted');
      }

      for (let colorIndex = 0; colorIndex < this.colorCount; colorIndex += 1) {
        const path = this.paths[colorIndex];
        const fromIndex = path[path.length - 1];
        const previousIndex = path.length > 1 ? path[path.length - 2] : -1;
        const toIndex = this.chooseNextNail(colorIndex, fromIndex, previousIndex);
        if (toIndex < 0) {
          throw new Error('No unused next nail available');
        }
        path.push(toIndex);
        this.commitLine(colorIndex, fromIndex, toIndex);
      }

      roundsCompleted += 1;
      const currentMatchRatio = this.getMatchRatio();
      if (currentMatchRatio > bestMatchRatio) {
        bestMatchRatio = currentMatchRatio;
        bestRoundsCompleted = roundsCompleted;
        explorationRemaining = 0;
      } else if (currentMatchRatio < bestMatchRatio && explorationRemaining === 0) {
        explorationRemaining = maxWorseningRounds;
      } else if (explorationRemaining > 0) {
        explorationRemaining -= 1;
      }

      if (onProgress) {
        onProgress({
          phase: 'stage1',
          roundIndex: roundsCompleted,
          matchRatio: this.getMatchRatio(),
          explorationRemaining,
          bestMatchRatio,
          maxWorseningRounds,
        });
      }

      if (explorationRemaining === 0 && currentMatchRatio < bestMatchRatio) {
        this.truncateToRounds(bestRoundsCompleted);
        stoppedEarly = true;
        break;
      }

      if (yieldEvery > 0 && (roundsCompleted % yieldEvery === 0)) {
        await pause();
      }
    }

    return {
      matchRatio: this.getMatchRatio(),
      roundsCompleted,
      stoppedEarly,
      bestMatchRatio,
    };
  }

  getPathLineIds(colorIndex, middleIndex) {
    const lineIds = this.pathLineIds[colorIndex] || [];
    if (middleIndex === 0) {
      return {
        lineIdA: -1,
        lineIdB: lineIds[0],
      };
    }

    return {
      lineIdA: lineIds[middleIndex - 1],
      lineIdB: lineIds[middleIndex],
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
    if (middleIndex < 0 || middleIndex >= path.length) {
      return 0;
    }

    const currentNail = path[middleIndex];
    if (candidateNail === currentNail) {
      return 0;
    }
    if (!this.isNailCandidateAllowed(currentNail, candidateNail)) {
      return 0;
    }

    if (middleIndex === 0) {
      if (path.length < 2) {
        return 0;
      }

      const nextNail = path[1];
      const lineIdB = this.getPathLineIds(colorIndex, middleIndex).lineIdB;
      const oldKeyB = this.getLineKey(currentNail, nextNail);
      const newKeyB = this.getLineKey(candidateNail, nextNail);

      if (this.isLineKeyBlocked(newKeyB, [oldKeyB])) {
        return 0;
      }

      const oldPixelsB = this.getLinePixels(currentNail, nextNail);
      const newPixelsB = this.getLinePixels(candidateNail, nextNail);
      const affectedPixels = uniquePixels(oldPixelsB, newPixelsB);
      const snapshots = affectedPixels.map((pixel) => ({
        pixel,
        coverage: this.coverage[pixel].slice(),
        color: this.currentColors[pixel],
      }));
      const matchedBefore = this.matchedCount;

      this.applyLineGeometrySwap({
        lineIdA: -1,
        oldPixelsA: new Uint32Array(0),
        newPixelsA: new Uint32Array(0),
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

      this.removeLineKey(oldKeyB);
      this.addLineKey(newKeyB);
      this.lineKeyById[lineIdB] = newKeyB;
      path[middleIndex] = candidateNail;
      return delta;
    }

    const prevNail = path[middleIndex - 1];
    const nextNail = path[middleIndex + 1];
    const { lineIdA, lineIdB } = this.getPathLineIds(colorIndex, middleIndex);
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

  rebuildRefineSweepOrder() {
    const order = [];

    for (let colorIndex = 0; colorIndex < this.colorCount; colorIndex += 1) {
      const path = this.paths[colorIndex];
      if (path.length < 2) {
        continue;
      }

      order.push({ colorIndex, middleIndex: 0 });

      for (let middleIndex = 1; middleIndex < path.length - 1; middleIndex += 1) {
        order.push({ colorIndex, middleIndex });
      }
    }

    shuffleArray(order);
    this.refineSweepOrder = order;
    this.refineSweepIndex = 0;
  }

  applyRefinementAt(colorIndex, middleIndex, shouldAbort = null) {
    if (shouldAbort && shouldAbort()) {
      throw new Error('aborted');
    }

    const { bestCandidate, bestDelta } = this.findBestMiddleNail(colorIndex, middleIndex, shouldAbort);

    if (bestDelta <= 0 || bestCandidate === this.paths[colorIndex][middleIndex]) {
      return { changed: false, delta: 0 };
    }

    const delta = this.evaluateMiddleNailChange(colorIndex, middleIndex, bestCandidate, true);
    return { changed: true, delta };
  }

  findBestMiddleNail(colorIndex, middleIndex, shouldAbort = null) {
    const path = this.paths[colorIndex];
    const currentNail = path[middleIndex];
    let bestCandidate = currentNail;
    let bestDelta = 0;

    const scanDirection = (direction) => {
      let candidate = clampIndex(currentNail + direction, this.nailCount);
      let localBestCandidate = currentNail;
      let localBestDelta = 0;

      for (let step = 0; step < this.localSearchRadius; step += 1) {
        if (shouldAbort && shouldAbort()) {
          throw new Error('aborted');
        }

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
      if (shouldAbort && shouldAbort()) {
        throw new Error('aborted');
      }

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
    if (!this.nailCount) {
      return { changed: false, delta: 0 };
    }

    if (this.refineSweepIndex >= this.refineSweepOrder.length) {
      this.rebuildRefineSweepOrder();
    }

    if (!this.refineSweepOrder.length) {
      return { changed: false, delta: 0 };
    }

    const { colorIndex, middleIndex } = this.refineSweepOrder[this.refineSweepIndex];
    this.refineSweepIndex += 1;
    return this.applyRefinementAt(colorIndex, middleIndex);
  }

  async refineSweep({ yieldEvery = 50, onAcceptedMove, shouldAbort = null } = {}) {
    if (!this.nailCount) {
      return { changedCount: 0, totalDelta: 0 };
    }

    if (this.refineSweepIndex >= this.refineSweepOrder.length) {
      this.rebuildRefineSweepOrder();
    }

    if (!this.refineSweepOrder.length) {
      return { changedCount: 0, totalDelta: 0 };
    }

    let changedCount = 0;
    let totalDelta = 0;
    let processed = 0;

    while (this.refineSweepIndex < this.refineSweepOrder.length) {
      if (shouldAbort && shouldAbort()) {
        throw new Error('aborted');
      }

      const { colorIndex, middleIndex } = this.refineSweepOrder[this.refineSweepIndex];
      this.refineSweepIndex += 1;
      const result = this.applyRefinementAt(colorIndex, middleIndex, shouldAbort);
      if (result.changed) {
        changedCount += 1;
        totalDelta += result.delta;
        if (onAcceptedMove) {
          await onAcceptedMove({
            colorIndex,
            middleIndex,
            delta: result.delta,
            changedCount,
            totalDelta,
          });
        }
      }

      processed += 1;
      if (yieldEvery > 0 && (processed % yieldEvery === 0)) {
        await pause();
      }
    }

    return { changedCount, totalDelta };
  }

  async refineMany({ iterations, onProgress, yieldEvery = 20, onAcceptedMove, shouldAbort = null } = {}) {
    let changedCount = 0;
    let totalDelta = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const result = await this.refineSweep({ yieldEvery, onAcceptedMove, shouldAbort });
      changedCount += result.changedCount;
      totalDelta += result.totalDelta;

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
