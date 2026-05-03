import { clamp, isInsideCircle as isInsideCircleGeometry } from './geometry.js';
import { analyzeLinePoints, buildPaletteLookup, getDominantColorIndex, getSelectedLinePoints, rgbKey } from './line_tools.js';

const state = {
  loadedWidth: 0,
  loadedHeight: 0,
  circleCenterX: 0,
  circleCenterY: 0,
  circleRadius: 0,
  perimeterCount: 0,
  perimeterPoints: [],
  currentPaletteKeys: [],
  imageData: null,
  whiteData: null,
};

function setState(payload) {
  state.loadedWidth = payload.loadedWidth || 0;
  state.loadedHeight = payload.loadedHeight || 0;
  state.circleCenterX = payload.circleCenterX || 0;
  state.circleCenterY = payload.circleCenterY || 0;
  state.circleRadius = payload.circleRadius || 0;
  state.perimeterCount = payload.perimeterCount || 0;
  state.perimeterPoints = payload.perimeterPoints || [];
  state.currentPaletteKeys = payload.currentPaletteKeys || [];
  state.imageData = payload.imageData ? new Uint8ClampedArray(payload.imageData) : null;
  state.whiteData = payload.whiteData ? new Uint8ClampedArray(payload.whiteData) : null;
}

function isReady() {
  return (
    state.loadedWidth > 0 &&
    state.loadedHeight > 0 &&
    state.perimeterCount > 0 &&
    state.perimeterPoints.length > 0 &&
    state.currentPaletteKeys.length > 0 &&
    state.imageData &&
    state.whiteData
  );
}

function getScoreRuleValues(scoreRules = {}) {
  return {
    currentDominant: Number.isFinite(scoreRules.currentDominant) ? scoreRules.currentDominant : 0,
    targetDominant: Number.isFinite(scoreRules.targetDominant) ? scoreRules.targetDominant : 1.5,
    sameNonDominant: Number.isFinite(scoreRules.sameNonDominant) ? scoreRules.sameNonDominant : -1,
    otherwise: Number.isFinite(scoreRules.otherwise) ? scoreRules.otherwise : 0,
    lengthMultiplier: Number.isFinite(scoreRules.lengthMultiplier) ? scoreRules.lengthMultiplier : 2,
  };
}

function getLineLengthMultiplier(linePoints, baseMultiplier = null) {
  const effectiveMultiplier = Number.isFinite(baseMultiplier)
    ? Math.max(1, baseMultiplier)
    : Math.max(1, getScoreRuleValues().lengthMultiplier);

  if (!linePoints || linePoints.length < 2 || state.circleRadius <= 0) {
    return 1;
  }

  const startPoint = linePoints[0];
  const endPoint = linePoints[linePoints.length - 1];
  const lineLength = Math.max(1, Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y));
  const maxLength = Math.max(1, state.circleRadius * 2);
  const ratio = clamp((lineLength - 1) / Math.max(1, maxLength - 1), 0, 1);
  return 1 + (effectiveMultiplier - 1) * ratio;
}

function getPairScore(targetIndex, currentIndex, dominantIndex, scoreRules) {
  if (currentIndex === dominantIndex) {
    return scoreRules.currentDominant;
  }

  if (targetIndex === dominantIndex) {
    return scoreRules.targetDominant;
  }

  if (currentIndex === targetIndex) {
    return scoreRules.sameNonDominant;
  }

  return scoreRules.otherwise;
}

function computeLineContext(fromValue, toValue) {
  const linePoints = getSelectedLinePoints({
    rangeFromValue: fromValue,
    rangeToValue: toValue,
    perimeterCount: state.perimeterCount,
    perimeterPoints: state.perimeterPoints,
    isInsideCircle: (x, y) =>
      state.loadedWidth > 0 &&
      state.loadedHeight > 0 &&
      isInsideCircleGeometry(x, y, state.loadedWidth, state.loadedHeight, state.circleCenterX, state.circleCenterY, state.circleRadius),
  });

  const paletteLookup = buildPaletteLookup(state.currentPaletteKeys);
  const analysis = analyzeLinePoints({
    linePoints,
    width: state.loadedWidth,
    imageData: state.imageData,
    whiteData: state.whiteData,
    paletteLookup,
    paletteCount: state.currentPaletteKeys.length,
  });

  return { analysis, linePoints, paletteLookup };
}

function getLineScoreBreakdown(linePoints, paletteLookup, analysis, scoreRules) {
  const dominantIndex = getDominantColorIndex(analysis.imageCounts);
  const ingredients = new Map();
  let rawLineScore = 0;

  for (const point of linePoints) {
    const index = (point.y * state.loadedWidth + point.x) * 4;
    const leftAlpha = state.imageData[index + 3];
    if (leftAlpha < 8) {
      continue;
    }

    const leftKey = rgbKey(state.imageData[index], state.imageData[index + 1], state.imageData[index + 2]);
    const targetIndex = paletteLookup.get(leftKey);
    if (targetIndex === undefined) {
      continue;
    }

    const rightAlpha = state.whiteData[index + 3];
    const rightKey = rightAlpha >= 8
      ? rgbKey(state.whiteData[index], state.whiteData[index + 1], state.whiteData[index + 2])
      : 'white';
    let currentIndex = rightAlpha >= 8 ? paletteLookup.get(rightKey) : 'white';
    if (currentIndex === undefined) {
      currentIndex =
        state.whiteData[index] === 255 && state.whiteData[index + 1] === 255 && state.whiteData[index + 2] === 255
          ? 'white'
          : 'other';
    }

    const pixelScore = getPairScore(targetIndex, currentIndex, dominantIndex, scoreRules);
    rawLineScore += pixelScore;

    const ingredientKey = `${targetIndex}:${currentIndex}`;
    const ingredient = ingredients.get(ingredientKey) || {
      targetIndex,
      currentIndex,
      count: 0,
      score: pixelScore,
    };
    ingredient.count += 1;
    ingredients.set(ingredientKey, ingredient);
  }

  return {
    dominantIndex,
    rawLineScore,
    scoreIngredients: [...ingredients.values()],
  };
}

function computeDrawResult(payload) {
  const { fromValue, toValue } = payload;
  if (!isReady()) {
    return null;
  }

  const { analysis, linePoints, paletteLookup } = computeLineContext(fromValue, toValue);
  const dominantIndex = getDominantColorIndex(analysis.imageCounts);
  const dominantKey = state.currentPaletteKeys[dominantIndex] || null;

  return {
    dominantIndex,
    dominantKey,
    imageCounts: analysis.imageCounts,
    linePoints,
    whiteCounts: analysis.whiteCounts,
    whiteCount: analysis.whiteCount,
  };
}

function computeLineAnalytics(payload) {
  const { fromValue, toValue, scoreRules: rawScoreRules } = payload;
  if (!isReady()) {
    return null;
  }

  const scoreRules = getScoreRuleValues(rawScoreRules);
  const { analysis, linePoints, paletteLookup } = computeLineContext(fromValue, toValue);
  const { dominantIndex, rawLineScore, scoreIngredients } = getLineScoreBreakdown(
    linePoints,
    paletteLookup,
    analysis,
    scoreRules
  );
  const lengthMultiplier = getLineLengthMultiplier(linePoints, scoreRules.lengthMultiplier);

  return {
    dominantIndex,
    finalLineScore: rawLineScore * lengthMultiplier,
    imageCounts: analysis.imageCounts,
    linePoints,
    lengthMultiplier,
    scoreIngredients,
    whiteCount: analysis.whiteCount,
    whiteCounts: analysis.whiteCounts,
  };
}

function computeScoreChart(payload) {
  const { fromValue, minDistance, scoreRules: rawScoreRules } = payload;
  if (!isReady()) {
    return null;
  }

  const scoreRules = getScoreRuleValues(rawScoreRules);
  const paletteLookup = buildPaletteLookup(state.currentPaletteKeys);
  const scores = [];
  let minScore = 0;
  let maxScore = 0;
  let highestScore = Number.NEGATIVE_INFINITY;
  let highestToValue = 1;
  let bestEligibleScore = Number.NEGATIVE_INFINITY;
  let bestEligibleToValue = 1;

  for (let toValue = 1; toValue <= state.perimeterCount; toValue += 1) {
    const circularDistance = Math.abs(fromValue - toValue);
    const lineDistance = Math.min(circularDistance, state.perimeterCount - circularDistance);
    const linePoints = getSelectedLinePoints({
      rangeFromValue: fromValue,
      rangeToValue: toValue,
      perimeterCount: state.perimeterCount,
      perimeterPoints: state.perimeterPoints,
      isInsideCircle: (x, y) =>
        state.loadedWidth > 0 &&
        state.loadedHeight > 0 &&
        isInsideCircleGeometry(x, y, state.loadedWidth, state.loadedHeight, state.circleCenterX, state.circleCenterY, state.circleRadius),
    });
    const analysis = analyzeLinePoints({
      linePoints,
      width: state.loadedWidth,
      imageData: state.imageData,
      whiteData: state.whiteData,
      paletteLookup,
      paletteCount: state.currentPaletteKeys.length,
    });
    const dominantIndex = getDominantColorIndex(analysis.imageCounts);
    let lineScore = 0;

    for (const point of linePoints) {
      const index = (point.y * state.loadedWidth + point.x) * 4;
      const leftAlpha = state.imageData[index + 3];
      if (leftAlpha < 8) {
        continue;
      }

      const leftKey = rgbKey(state.imageData[index], state.imageData[index + 1], state.imageData[index + 2]);
      const targetIndex = paletteLookup.get(leftKey);
      if (targetIndex === undefined) {
        continue;
      }

      const rightAlpha = state.whiteData[index + 3];
      const rightKey = rightAlpha >= 8
        ? rgbKey(state.whiteData[index], state.whiteData[index + 1], state.whiteData[index + 2])
        : 'white';
      let currentIndex = rightAlpha >= 8 ? paletteLookup.get(rightKey) : 'white';
      if (currentIndex === undefined) {
        currentIndex =
          state.whiteData[index] === 255 && state.whiteData[index + 1] === 255 && state.whiteData[index + 2] === 255
            ? 'white'
            : 'other';
      }

      lineScore += getPairScore(targetIndex, currentIndex, dominantIndex, scoreRules);
    }

    const score = lineScore * getLineLengthMultiplier(linePoints, scoreRules.lengthMultiplier);
    scores.push({ score, toValue });
    minScore = Math.min(minScore, score);
    maxScore = Math.max(maxScore, score);

    const currentTotalCount = analysis.whiteCounts.reduce((sum, count) => sum + count, 0) + analysis.whiteCount;
    const isFullyCurrentDominantLine =
      currentTotalCount > 0 && analysis.whiteCounts[dominantIndex] === currentTotalCount;

    if (score > highestScore) {
      highestScore = score;
      highestToValue = toValue;
    }

    if (lineDistance >= minDistance && !isFullyCurrentDominantLine && score > bestEligibleScore) {
      bestEligibleScore = score;
      bestEligibleToValue = toValue;
    }
  }

  if (bestEligibleScore !== Number.NEGATIVE_INFINITY) {
    highestScore = bestEligibleScore;
    highestToValue = bestEligibleToValue;
  }

  return {
    axisValueBottom: minScore < 0 ? minScore : 0,
    axisValueTop: maxScore > 0 ? maxScore : 0,
    highestToValue,
    scores,
  };
}

self.onmessage = (event) => {
  const { type, requestId, payload, version } = event.data || {};

  try {
    if (type === 'sync-state') {
      setState(payload || {});
      return;
    }

    let result = null;
    if (type === 'compute-draw') {
      result = computeDrawResult(payload || {});
    } else if (type === 'compute-line-analytics') {
      result = computeLineAnalytics(payload || {});
    } else if (type === 'compute-score-chart') {
      result = computeScoreChart(payload || {});
    } else {
      throw new Error(`Unknown worker message type: ${type}`);
    }

    self.postMessage({
      requestId,
      result,
      type,
      version,
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      requestId,
      type,
      version,
    });
  }
};
