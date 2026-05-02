import { oklabToRgb, quantizeImageDataDetailed } from './quantize.js';
import {
  buildCirclePerimeter,
  clamp,
  clampInt,
  getLinePoints,
  isInsideCircle as isInsideCircleGeometry,
} from './geometry.js';
import {
  analyzeLinePoints,
  buildPaletteLookup,
  getDominantColorIndex,
  getSelectedLinePoints,
  paintLinePixels,
  rgbKey,
} from './line_tools.js';

const imageInput = document.getElementById('imageInput');
const paletteInput = document.getElementById('paletteCount');
const modeClosestButton = document.getElementById('modeClosest');
const modeDitheredButton = document.getElementById('modeDithered');
const rangeFromInput = document.getElementById('rangeFrom');
const rangeToInput = document.getElementById('rangeTo');
const rangeFromValue = document.getElementById('rangeFromValue');
const rangeToValue = document.getElementById('rangeToValue');
const minDistanceInput = document.getElementById('minDistance');
const scoreRuleCurrentDominantInput = document.getElementById('scoreRuleCurrentDominant');
const scoreRuleTargetDominantInput = document.getElementById('scoreRuleTargetDominant');
const scoreRuleSameNonDominantInput = document.getElementById('scoreRuleSameNonDominant');
const scoreRuleOtherwiseInput = document.getElementById('scoreRuleOtherwise');
const scoreRuleLengthMultiplierInput = document.getElementById('scoreRuleLengthMultiplier');
const lineAnalytics = document.getElementById('lineAnalytics');
const lineAnalyticsPanels = document.getElementById('lineAnalyticsPanels');
const chooseImageButton = document.getElementById('chooseImageButton');
const drawLineButton = document.getElementById('drawLine');
const loopLineButton = document.getElementById('loopLine');
const exportButton = document.getElementById('exportButton');
const dropZone = document.getElementById('dropZone');
const dropCopy = document.getElementById('dropCopy');
const scoreChart = document.getElementById('scoreChart');
const scoreChartSubtitle = document.getElementById('scoreChartSubtitle');
const viewer = document.getElementById('viewer');
const imageStage = document.getElementById('imageStage');
const imageCanvas = document.getElementById('imageCanvas');
const imageOverlay = document.getElementById('imageOverlay');
const imageRangeOverlay = document.getElementById('imageRangeOverlay');
const imagePixelBox = document.getElementById('imagePixelBox');
const whiteStage = document.getElementById('whiteStage');
const whiteCanvas = document.getElementById('whiteCanvas');
const whiteOverlay = document.getElementById('whiteOverlay');
const whiteRangeOverlay = document.getElementById('whiteRangeOverlay');
const whitePixelBox = document.getElementById('whitePixelBox');
const hint = document.getElementById('hint');
const swatch = document.getElementById('swatch');
const colorLabel = document.getElementById('colorLabel');
const coordLabel = document.getElementById('coordLabel');
const statusLabel = document.getElementById('statusLabel');
const defaultImageSrc = 'mona_lisa.PNG';

const imageCtx = imageCanvas.getContext('2d', { willReadFrequently: true });
const whiteCtx = whiteCanvas.getContext('2d', { willReadFrequently: true });
const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
const loaderImage = new Image();

let currentUrl = null;
let loadedWidth = 0;
let loadedHeight = 0;
let hovered = false;
let lastPointer = null;
let scoreExpanded = false;
let targetLineExpanded = false;
let currentLineExpanded = false;
let scoreChartRevision = 0;
let scoreChartCacheKey = null;
let scoreChartActiveTo = null;
let scoreChartHighestToValue = null;
let scoreChartHidden = false;
let exportedToValues = [];
let loopActive = false;
let loopTimer = null;
let zoom = 1;
let ignoreNextImageLoad = false;
let quantizeRequestId = 0;
let quantizeMode = 'closest';
let currentPaletteCenters = [];
let currentPaletteKeys = [];
let perimeterPoints = [];
let perimeterLookup = new Map();
let perimeterCount = 1;
let rangeLastTouched = 'to';
let circleCenterX = 0;
let circleCenterY = 0;
let circleRadius = 0;
let panX = 0;
let panY = 0;
let dragging = false;
let dragPointerId = null;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;
const zoomMin = 0.25;
const zoomMax = 24;

function getPaletteCount() {
  return clampInt(paletteInput.value, 2, 32, 8);
}

function getMinDistanceValue(maxValue) {
  if (!minDistanceInput) {
    return 0;
  }

  return clampInt(minDistanceInput.value, 0, Math.max(0, Math.floor(maxValue / 2)), 20);
}

function wrapPerimeterValue(value, maxValue) {
  if (maxValue <= 1) {
    return 1;
  }

  const zeroBased = ((value - 1) % maxValue + maxValue) % maxValue;
  return zeroBased + 1;
}

function getCircularDistance(fromValue, toValue, maxValue) {
  if (maxValue <= 1) {
    return 0;
  }

  const rawDistance = Math.abs(fromValue - toValue);
  return Math.min(rawDistance, maxValue - rawDistance);
}

function rebuildPaletteKeys(centers) {
  currentPaletteCenters = centers || [];
  currentPaletteKeys = currentPaletteCenters.map((center) => {
    const [r, g, b] = oklabToRgb(center[0], center[1], center[2]);
    return rgbKey(r, g, b);
  });
}

function getScoreRuleValues() {
  const parseRule = (input, fallback) => {
    if (!input) {
      return fallback;
    }

    const parsed = Number.parseInt(input.value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    currentDominant: parseRule(scoreRuleCurrentDominantInput, 0),
    targetDominant: parseRule(scoreRuleTargetDominantInput, 1),
    sameNonDominant: parseRule(scoreRuleSameNonDominantInput, -1),
    otherwise: parseRule(scoreRuleOtherwiseInput, 0),
    lengthMultiplier: (() => {
      const parsed = Number.parseFloat(scoreRuleLengthMultiplierInput?.value);
      return Number.isFinite(parsed) ? parsed : 2;
    })(),
  };
}

function formatScoreValue(value) {
  const rounded = Math.round(value * 100) / 100;
  if (Object.is(rounded, -0) || Math.abs(rounded) < 1e-9) {
    return '0';
  }

  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

function formatSignedScoreValue(value) {
  const rounded = Math.round(value * 100) / 100;
  const prefix = rounded > 0 ? '+' : '';
  return `${prefix}${formatScoreValue(rounded)}`;
}

function getLineLengthMultiplier(linePoints, baseMultiplier = null) {
  const effectiveMultiplier = Number.isFinite(baseMultiplier)
    ? Math.max(1, baseMultiplier)
    : Math.max(1, getScoreRuleValues().lengthMultiplier);
  if (!linePoints || linePoints.length < 2 || circleRadius <= 0) {
    return 1;
  }

  const startPoint = linePoints[0];
  const endPoint = linePoints[linePoints.length - 1];
  const lineLength = Math.max(1, Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y));
  const maxLength = Math.max(1, circleRadius * 2);
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

function showViewer() {
  viewer.classList.remove('hidden');
  hint.classList.remove('hidden');
  dropCopy.classList.add('hidden');
}

function hideViewer() {
  viewer.classList.add('hidden');
  hint.classList.add('hidden');
  dropCopy.classList.remove('hidden');
  imagePixelBox.style.opacity = '0';
  whitePixelBox.style.opacity = '0';
  if (statusLabel) {
    statusLabel.classList.add('hidden');
  }
  hovered = false;
  endDrag();
}

function renderZoom() {
  if (!loadedWidth || !loadedHeight) {
    return;
  }

  const width = loadedWidth * zoom;
  const height = loadedHeight * zoom;

  imageCanvas.style.width = `${width}px`;
  imageCanvas.style.height = `${height}px`;
  whiteCanvas.style.width = `${width}px`;
  whiteCanvas.style.height = `${height}px`;
  imageStage.style.width = `${width}px`;
  imageStage.style.height = `${height}px`;
  whiteStage.style.width = `${width}px`;
  whiteStage.style.height = `${height}px`;
  imageStage.parentElement.style.width = `${width}px`;
  imageStage.parentElement.style.height = `${height}px`;
  whiteStage.parentElement.style.width = `${width}px`;
  whiteStage.parentElement.style.height = `${height}px`;
}

function centerPanels() {
  panX = 0;
  panY = 0;
  viewer.style.transform = `translate(${panX}px, ${panY}px)`;
}

function applyPan() {
  viewer.style.transform = `translate(${panX}px, ${panY}px)`;
}

function endDrag() {
  dragging = false;
  dragPointerId = null;
  viewer.classList.remove('dragging');
}

function getPerimeterCount() {
  return perimeterPoints.length;
}

function getPerimeterIndex(x, y) {
  const key = `${x},${y}`;
  return perimeterLookup.get(key) || null;
}

function getPerimeterPoint(index) {
  if (index < 1 || index > perimeterPoints.length) {
    return null;
  }

  return perimeterPoints[index - 1];
}

function isInsideCircle(x, y) {
  return loadedWidth > 0 &&
    loadedHeight > 0 &&
    isInsideCircleAt(x, y);
}

function isInsideCircleAt(x, y) {
  return isInsideCircleGeometry(x, y, loadedWidth, loadedHeight, circleCenterX, circleCenterY, circleRadius);
}

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function renderMaskedImage(ctx, canvas, width, height, sourceData, fillWhite) {
  canvas.width = width;
  canvas.height = height;
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (!isInsideCircle(x, y)) {
        data[index + 3] = 0;
        continue;
      }

      if (fillWhite) {
        data[index] = 255;
        data[index + 1] = 255;
        data[index + 2] = 255;
        data[index + 3] = 255;
      } else {
        data[index] = sourceData[index];
        data[index + 1] = sourceData[index + 1];
        data[index + 2] = sourceData[index + 2];
        data[index + 3] = sourceData[index + 3];
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function drawRangeOverlay(overlay, stageEl, panelWidth, panelHeight) {
  overlay.innerHTML = '';

  if (!loadedWidth || !loadedHeight || perimeterPoints.length === 0) {
    return;
  }

  const fromValue = clampInt(rangeFromInput.value, 1, perimeterCount, 1);
  const toValue = clampInt(rangeToInput.value, 1, perimeterCount, perimeterCount);
  rangeFromValue.textContent = String(fromValue);
  rangeToValue.textContent = String(toValue);

  const startPoint = getPerimeterPoint(fromValue);
  const endPoint = getPerimeterPoint(toValue);
  if (!startPoint || !endPoint) {
    return;
  }

  const stageRect = stageEl.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const scaleX = stageRect.width / loadedWidth;
  const scaleY = stageRect.height / loadedHeight;
  const linePoints = getLinePoints(startPoint.x, startPoint.y, endPoint.x, endPoint.y);

  for (const point of linePoints) {
    if (!isInsideCircle(point.x, point.y)) {
      continue;
    }

    const pixel = document.createElement('div');
    pixel.className = 'range-pixel';
    pixel.style.left = `${stageRect.left - overlayRect.left + point.x * scaleX}px`;
    pixel.style.top = `${stageRect.top - overlayRect.top + point.y * scaleY}px`;
    pixel.style.width = `${Math.max(scaleX, 1)}px`;
    pixel.style.height = `${Math.max(scaleY, 1)}px`;
    overlay.appendChild(pixel);
  }
}

function renderAllRangeOverlays() {
  drawRangeOverlay(imageRangeOverlay, imageStage, loadedWidth, loadedHeight);
  drawRangeOverlay(whiteRangeOverlay, whiteStage, loadedWidth, loadedHeight);
  renderLineAnalytics();
  renderScoreChart();
}

function invalidateScoreChart() {
  scoreChartRevision += 1;
  scoreChartCacheKey = null;
  scoreChartActiveTo = null;
  scoreChartHighestToValue = null;
}

function getLineScoreForPoints(linePoints, paletteLookup, imageData, whiteData, analysis = null, scoreRules = null) {
  if (!loadedWidth || !loadedHeight || perimeterPoints.length === 0 || currentPaletteCenters.length === 0) {
    return 0;
  }

  if (!linePoints.length) {
    return 0;
  }

  const dominantIndex = analysis
    ? getDominantColorIndex(analysis.imageCounts)
    : getDominantColorIndex(
        analyzeLinePoints({
          linePoints,
          width: loadedWidth,
          imageData,
          whiteData,
          paletteLookup,
          paletteCount: currentPaletteCenters.length,
        }).imageCounts
      );

  let lineScore = 0;
  const activeScoreRules = scoreRules || getScoreRuleValues();
  for (const point of linePoints) {
    const index = (point.y * loadedWidth + point.x) * 4;
    const leftAlpha = imageData[index + 3];
    if (leftAlpha < 8) {
      continue;
    }

    const leftKey = rgbKey(imageData[index], imageData[index + 1], imageData[index + 2]);
    const targetIndex = paletteLookup.get(leftKey);
    if (targetIndex === undefined) {
      continue;
    }

    const rightAlpha = whiteData[index + 3];
    const rightKey = rightAlpha >= 8
      ? rgbKey(whiteData[index], whiteData[index + 1], whiteData[index + 2])
      : 'white';
    let currentIndex = rightAlpha >= 8 ? paletteLookup.get(rightKey) : 'white';
    if (currentIndex === undefined) {
      currentIndex =
        whiteData[index] === 255 && whiteData[index + 1] === 255 && whiteData[index + 2] === 255
          ? 'white'
          : 'other';
    }

    lineScore += getPairScore(targetIndex, currentIndex, dominantIndex, activeScoreRules);
  }

  return lineScore * getLineLengthMultiplier(linePoints, activeScoreRules.lengthMultiplier);
}

function updateScoreChartSelection(toValue) {
  if (!scoreChart) {
    return;
  }

  const nextActiveTo = clampInt(toValue, 1, perimeterCount, 1);
  if (scoreChartActiveTo === nextActiveTo) {
    return;
  }

  if (scoreChartActiveTo !== null) {
    const previousBar = scoreChart.querySelector(`.chart-bar[data-to="${scoreChartActiveTo}"]`);
    if (previousBar) {
      previousBar.classList.remove('is-active');
    }
  }

  const activeBar = scoreChart.querySelector(`.chart-bar[data-to="${nextActiveTo}"]`);
  if (activeBar) {
    activeBar.classList.add('is-active');
  }

  scoreChartActiveTo = nextActiveTo;
}

function updateScoreChartSubtitle(highestToValue) {
  if (!scoreChartSubtitle) {
    return;
  }

  const displayValue = highestToValue ?? scoreChartHighestToValue;
  scoreChartSubtitle.innerHTML = `
    <span class="score-chart-highest">Highest:</span>
    <button type="button" class="score-chart-to-button" data-to="${displayValue ?? ''}" ${displayValue === null ? 'disabled' : ''}>${displayValue ?? '--'}</button>
    <button type="button" class="score-chart-hide-button" data-action="toggle-chart">${scoreChartHidden ? 'show' : 'hide'}</button>
  `;
}

function computeScoreChartStats(fromValue, minDistance) {
  const paletteLookup = buildPaletteLookup(currentPaletteKeys);
  const imageData = imageCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const whiteData = whiteCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const scoreRules = getScoreRuleValues();
  const scores = [];
  let minScore = 0;
  let maxScore = 0;
  let highestScore = Number.NEGATIVE_INFINITY;
  let highestToValue = 1;
  let bestEligibleScore = Number.NEGATIVE_INFINITY;
  let bestEligibleToValue = 1;

  for (let toValue = 1; toValue <= perimeterCount; toValue += 1) {
    const circularDistance = getCircularDistance(fromValue, toValue, perimeterCount);
    const linePoints = getSelectedLinePoints({
      rangeFromValue: fromValue,
      rangeToValue: toValue,
      perimeterCount,
      perimeterPoints,
      isInsideCircle: isInsideCircleAt,
    });
    const analysis = analyzeLinePoints({
      linePoints,
      width: loadedWidth,
      imageData,
      whiteData,
      paletteLookup,
      paletteCount: currentPaletteCenters.length,
    });
    const dominantIndex = getDominantColorIndex(analysis.imageCounts);
    const score = getLineScoreForPoints(linePoints, paletteLookup, imageData, whiteData, analysis, scoreRules);
    scores.push({ toValue, score });
    minScore = Math.min(minScore, score);
    maxScore = Math.max(maxScore, score);
    const currentTotalCount = analysis.whiteCounts.reduce((sum, count) => sum + count, 0) + analysis.whiteCount;
    const isFullyCurrentDominantLine =
      currentTotalCount > 0 && analysis.whiteCounts[dominantIndex] === currentTotalCount;

    if (score > highestScore) {
      highestScore = score;
      highestToValue = toValue;
    }

    if (circularDistance >= minDistance && !isFullyCurrentDominantLine && score > bestEligibleScore) {
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
    maxScore,
    minScore,
    scores,
  };
}

function renderScoreChart() {
  if (!scoreChart) {
    return;
  }

  if (!loadedWidth || !loadedHeight || perimeterPoints.length === 0 || currentPaletteCenters.length === 0) {
    scoreChart.innerHTML = '';
    scoreChartCacheKey = null;
    scoreChartActiveTo = null;
    scoreChartHighestToValue = null;
    updateScoreChartSubtitle(null);
    return;
  }

  const fromValue = clampInt(rangeFromInput.value, 1, perimeterCount, 1);
  const currentToValue = clampInt(rangeToInput.value, 1, perimeterCount, 1);
  const minDistance = getMinDistanceValue(perimeterCount);
  const cacheKey = `${scoreChartRevision}:${fromValue}`;

  if (scoreChartHidden) {
    const { highestToValue } = computeScoreChartStats(fromValue, minDistance);
    scoreChartHighestToValue = highestToValue;
    updateScoreChartSubtitle(highestToValue);
    scoreChart.innerHTML = '';
    scoreChartCacheKey = null;
    scoreChartActiveTo = null;
    return;
  }

  if (scoreChartCacheKey === cacheKey && scoreChart.innerHTML) {
    updateScoreChartSelection(currentToValue);
    return;
  }

  const { axisValueBottom, axisValueTop, highestToValue, maxScore, minScore, scores } =
    computeScoreChartStats(fromValue, minDistance);

  scoreChartHighestToValue = highestToValue;
  updateScoreChartSubtitle(highestToValue);

  const graphWidth = Math.max(520, perimeterCount * 18 + 90);
  const graphHeight = 1800;
  const graphPadding = { top: 26, right: 18, bottom: 34, left: 38 };
  const graphInnerWidth = graphWidth - graphPadding.left - graphPadding.right;
  const graphInnerHeight = graphHeight - graphPadding.top - graphPadding.bottom;
  const barWidth = graphInnerWidth / scores.length;
  const valueRange = Math.max(1, maxScore - minScore);
  const zeroY =
    minScore >= 0
      ? graphHeight - graphPadding.bottom
      : maxScore <= 0
        ? graphPadding.top
        : graphHeight - graphPadding.bottom - ((0 - minScore) / valueRange) * graphInnerHeight;

  scoreChart.innerHTML = `
    <div class="score-graph">
      <svg viewBox="0 0 ${graphWidth} ${graphHeight}" aria-label="Line score by To value">
        <line
          class="chart-axis"
          x1="${graphPadding.left}"
          y1="${graphPadding.top}"
          x2="${graphPadding.left}"
          y2="${graphHeight - graphPadding.bottom}"
        />
        <line
          class="chart-axis"
          x1="${graphPadding.left}"
          y1="${graphHeight - graphPadding.bottom}"
          x2="${graphWidth - graphPadding.right}"
          y2="${graphHeight - graphPadding.bottom}"
        />
        ${scores
          .map((point, index) => {
            const barHeight = (Math.abs(point.score) / valueRange) * graphInnerHeight;
            const x = graphPadding.left + index * barWidth;
            const y = point.score >= 0 ? zeroY - barHeight : zeroY;
            const isPositive = point.score >= 0;
            return `
              <rect
                class="chart-bar ${isPositive ? 'positive' : 'negative'}${point.toValue === currentToValue ? ' is-active' : ''}"
                data-to="${point.toValue}"
                x="${x}"
                y="${y}"
                width="${Math.max(barWidth + 0.35, 0.6)}"
                height="${barHeight}"
              />
            `;
          })
          .join('')}
        <text class="chart-label" x="${graphPadding.left}" y="${graphHeight - 4}">1</text>
        <text
          class="chart-label"
          x="${graphWidth - graphPadding.right}"
          y="${graphHeight - 4}"
          text-anchor="end"
        >
          ${perimeterCount}
        </text>
        <text class="chart-label" x="10" y="${graphPadding.top + 4}">${formatScoreValue(axisValueTop)}</text>
        <text
          class="chart-label"
          x="14"
          y="${graphHeight - graphPadding.bottom}"
          dominant-baseline="ideographic"
        >
          ${formatScoreValue(axisValueBottom)}
        </text>
      </svg>
    </div>
  `;
  scoreChartCacheKey = cacheKey;
  scoreChartActiveTo = currentToValue;
}

function setToValue(toValue) {
  const nextToValue = clampInt(toValue, 1, Math.max(1, perimeterCount), 1);
  rangeToInput.value = String(nextToValue);
  rangeToInput.dataset.touched = 'true';
  rangeToInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function stopLoop() {
  loopActive = false;
  if (loopTimer !== null) {
    window.clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (loopLineButton) {
    loopLineButton.textContent = 'Loop';
    loopLineButton.classList.remove('active');
  }
}

function startLoop() {
  if (!loopLineButton || loopActive) {
    return;
  }

  loopActive = true;
  loopLineButton.textContent = 'Stop';
  loopLineButton.classList.add('active');

  const step = () => {
    if (!loopActive) {
      return;
    }

    if (scoreChartHighestToValue === null) {
      stopLoop();
      return;
    }

    setToValue(scoreChartHighestToValue);
    if (!loopActive) {
      return;
    }

    drawDominantColorLine();
    if (!loopActive) {
      return;
    }

    loopTimer = window.setTimeout(step, 0);
  };

  step();
}

function toggleLoop() {
  if (loopActive) {
    stopLoop();
    return;
  }

  startLoop();
}

function renderLineAnalytics() {
  if (!lineAnalyticsPanels || !drawLineButton) {
    return;
  }

  if (!loadedWidth || !loadedHeight || perimeterPoints.length === 0 || currentPaletteCenters.length === 0) {
    lineAnalyticsPanels.innerHTML = '';
    drawLineButton.disabled = true;
    return;
  }

  const linePoints = getSelectedLinePoints({
    rangeFromValue: rangeFromInput.value,
    rangeToValue: rangeToInput.value,
    perimeterCount,
    perimeterPoints,
    isInsideCircle: isInsideCircleAt,
  });
  if (!linePoints.length) {
    lineAnalyticsPanels.innerHTML = '';
    drawLineButton.disabled = true;
    return;
  }

  const totalPoints = linePoints.length;
  const formatShare = (count) => `${count} (${((count / totalPoints) * 100).toFixed(1)}%)`;

  const paletteLookup = buildPaletteLookup(currentPaletteKeys);
  const imageData = imageCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const whiteData = whiteCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const scoreRules = getScoreRuleValues();
  const { imageCounts, whiteCounts, whiteCount } = analyzeLinePoints({
    linePoints,
    width: loadedWidth,
    imageData,
    whiteData,
    paletteLookup,
    paletteCount: currentPaletteCenters.length,
  });

  const dominantIndex = getDominantColorIndex(imageCounts);
  const scoreIngredients = new Map();
  let rawLineScore = 0;
  const lengthMultiplier = getLineLengthMultiplier(linePoints, scoreRules.lengthMultiplier);

  const getColorLabel = (paletteIndex) => {
    if (paletteIndex === 'white') {
      return 'White';
    }

    if (paletteIndex === 'other') {
      return 'Other';
    }

    return `Color ${paletteIndex + 1}`;
  };

  for (const point of linePoints) {
    const index = (point.y * loadedWidth + point.x) * 4;
    const rightAlpha = whiteData[index + 3];
    const leftAlpha = imageData[index + 3];

    if (leftAlpha < 8) {
      continue;
    }

    const leftKey = rgbKey(imageData[index], imageData[index + 1], imageData[index + 2]);
    const targetIndex = paletteLookup.get(leftKey);
    if (targetIndex === undefined) {
      continue;
    }

    const rightKey = rightAlpha >= 8
      ? rgbKey(whiteData[index], whiteData[index + 1], whiteData[index + 2])
      : 'white';
    let currentIndex = rightAlpha >= 8 ? paletteLookup.get(rightKey) : 'white';
    if (currentIndex === undefined) {
      currentIndex =
        whiteData[index] === 255 && whiteData[index + 1] === 255 && whiteData[index + 2] === 255
          ? 'white'
          : 'other';
    }

    const pixelScore = getPairScore(targetIndex, currentIndex, dominantIndex, scoreRules);

    rawLineScore += pixelScore;

    const ingredientKey = `${targetIndex}:${currentIndex}`;
    const ingredient = scoreIngredients.get(ingredientKey) || {
      targetIndex,
      currentIndex,
      count: 0,
      score: pixelScore,
    };
    ingredient.count += 1;
    scoreIngredients.set(ingredientKey, ingredient);
  }

  const targetColorIndexes = currentPaletteCenters.map((center, index) => index);
  const currentColorIndexes = [...targetColorIndexes, 'white'];
  const scoreRows = targetColorIndexes
    .flatMap((targetIndex) =>
      currentColorIndexes.map((currentIndex) => {
        const score = getPairScore(targetIndex, currentIndex, dominantIndex, scoreRules);
        const ingredient = scoreIngredients.get(`${targetIndex}:${currentIndex}`);
        return {
          targetIndex,
          currentIndex,
          count: ingredient ? ingredient.count : 0,
          score,
        };
      })
    )
    .map((ingredient) => {
      const contribution = ingredient.count * ingredient.score;
      return `<div class="analytics-row"><span>[${getColorLabel(ingredient.targetIndex)}, ${getColorLabel(ingredient.currentIndex)}] x ${ingredient.count}</span><strong>${ingredient.score} each = ${formatSignedScoreValue(contribution)}</strong></div>`;
    })
    .join('');

  const finalLineScore = rawLineScore * lengthMultiplier;
  let scoreSummaryRows = `
    <div class="analytics-row"><span>Dominant target</span><strong>${getColorLabel(dominantIndex)}</strong></div>
    ${scoreRows}
    <div class="analytics-row"><span>Length factor</span><strong>x${formatScoreValue(lengthMultiplier)}</strong></div>
    <div class="analytics-row score-total"><span>Sum</span><strong>${formatSignedScoreValue(finalLineScore)}</strong></div>
  `;

  const imageRows = currentPaletteCenters
    .map((center, index) => `<div class="analytics-row"><span>Color ${index + 1}</span><strong>${formatShare(imageCounts[index])}</strong></div>`)
    .join('');
  const whiteRows =
    currentPaletteCenters
      .map((center, index) => `<div class="analytics-row"><span>Color ${index + 1}</span><strong>${formatShare(whiteCounts[index])}</strong></div>`)
      .join('') + `<div class="analytics-row"><span>White</span><strong>${formatShare(whiteCount)}</strong></div>`;

  const scorePanel = `
    <button
      id="scoreToggle"
      type="button"
      class="analytics-title analytics-toggle"
      aria-expanded="${scoreExpanded ? 'true' : 'false'}"
    >
      Score
    </button>
    <div class="analytics-collapsible ${scoreExpanded ? 'expanded' : 'collapsed'}">
      <div class="analytics-list">${scoreSummaryRows}</div>
    </div>
  `;

  const targetLinePanel = `
    <button
      id="targetLineToggle"
      type="button"
      class="analytics-title analytics-toggle"
      aria-expanded="${targetLineExpanded ? 'true' : 'false'}"
    >
      Target line
    </button>
    <div class="analytics-collapsible ${targetLineExpanded ? 'expanded' : 'collapsed'}">
      <div class="analytics-list">${imageRows}</div>
    </div>
  `;

  const currentLinePanel = `
    <button
      id="currentLineToggle"
      type="button"
      class="analytics-title analytics-toggle"
      aria-expanded="${currentLineExpanded ? 'true' : 'false'}"
    >
      Current line
    </button>
    <div class="analytics-collapsible ${currentLineExpanded ? 'expanded' : 'collapsed'}">
      <div class="analytics-list">${whiteRows}</div>
    </div>
  `;

  lineAnalyticsPanels.innerHTML = `
    <div class="analytics-panel">
      ${targetLinePanel}
    </div>
    <div class="analytics-panel">
      ${currentLinePanel}
    </div>
    <div class="analytics-panel">
      ${scorePanel}
    </div>
  `;

  const targetLineToggle = document.getElementById('targetLineToggle');
  if (targetLineToggle) {
    targetLineToggle.addEventListener('click', () => {
      targetLineExpanded = !targetLineExpanded;
      renderLineAnalytics();
    });
  }

  const currentLineToggle = document.getElementById('currentLineToggle');
  if (currentLineToggle) {
    currentLineToggle.addEventListener('click', () => {
      currentLineExpanded = !currentLineExpanded;
      renderLineAnalytics();
    });
  }

  const scoreToggle = document.getElementById('scoreToggle');
  if (scoreToggle) {
    scoreToggle.addEventListener('click', () => {
      scoreExpanded = !scoreExpanded;
      renderLineAnalytics();
    });
  }
  drawLineButton.disabled = false;
}

const advancedControls = [
  minDistanceInput,
  scoreRuleCurrentDominantInput,
  scoreRuleTargetDominantInput,
  scoreRuleSameNonDominantInput,
  scoreRuleOtherwiseInput,
  scoreRuleLengthMultiplierInput,
].filter(Boolean);

for (const input of advancedControls) {
  input.addEventListener('input', () => {
    if (input === minDistanceInput) {
      setRangeBounds();
    }
    invalidateScoreChart();
    renderAllRangeOverlays();
  });
}

if (scoreChartSubtitle) {
  scoreChartSubtitle.addEventListener('click', (event) => {
    const button = event.target.closest('.score-chart-to-button');
    if (button) {
      const nextToValue = button.dataset.to;
      if (!nextToValue) {
        return;
      }

      setToValue(nextToValue);
      return;
    }

    const hideButton = event.target.closest('.score-chart-hide-button');
    if (!hideButton) {
      return;
    }

    scoreChartHidden = !scoreChartHidden;
    renderScoreChart();
  });
}

function updateExportButton() {
  if (exportButton) {
    exportButton.textContent = `Export ${exportedToValues.length}`;
    exportButton.disabled = exportedToValues.length === 0;
  }
}

function exportToValues() {
  if (!exportedToValues.length) {
    return;
  }

  const lines = [String(exportedToValues.length), ...exportedToValues.map((value) => String(value))];
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'to-values.txt';
  anchor.click();
  URL.revokeObjectURL(url);
}

function drawDominantColorLine() {
  if (!loadedWidth || !loadedHeight) {
    return;
  }

  const linePoints = getSelectedLinePoints({
    rangeFromValue: rangeFromInput.value,
    rangeToValue: rangeToInput.value,
    perimeterCount,
    perimeterPoints,
    isInsideCircle: isInsideCircleAt,
  });
  if (!linePoints.length || currentPaletteCenters.length === 0) {
    return;
  }

  const paletteLookup = buildPaletteLookup(currentPaletteKeys);
  const imageData = imageCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const whiteData = whiteCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const { imageCounts, whiteCounts } = analyzeLinePoints({
    linePoints,
    width: loadedWidth,
    imageData,
    whiteData,
    paletteLookup,
    paletteCount: currentPaletteCenters.length,
  });

  const dominantIndex = getDominantColorIndex(imageCounts);
  const dominantKey = currentPaletteKeys[dominantIndex];
  if (!dominantKey) {
    return;
  }

  exportedToValues.push(clampInt(rangeToInput.value, 1, perimeterCount, perimeterCount));
  updateExportButton();

  const [r, g, b] = dominantKey.split(',').map((value) => Number.parseInt(value, 10));
  const targetImageData = whiteCtx.getImageData(0, 0, loadedWidth, loadedHeight);
  const targetData = targetImageData.data;

  paintLinePixels({
    linePoints,
    width: loadedWidth,
    targetData,
    r,
    g,
    b,
    a: 255,
  });

  whiteCtx.putImageData(targetImageData, 0, 0);
  invalidateScoreChart();

  const fromValue = rangeFromInput.value;
  rangeFromInput.value = rangeToInput.value;
  rangeToInput.value = fromValue;
  rangeFromInput.dataset.touched = 'true';
  rangeToInput.dataset.touched = 'true';
  setRangeBounds();

  renderAllRangeOverlays();

  if (hovered && lastPointer) {
    renderHoverOverlays(lastPointer.x, lastPointer.y);
  }
}

function paintHoverBox(pixelBox, stageEl, overlayEl, px, py) {
  const rect = stageEl.getBoundingClientRect();
  const overlayRect = overlayEl.getBoundingClientRect();
  const pixelWidth = rect.width / loadedWidth;
  const pixelHeight = rect.height / loadedHeight;

  pixelBox.style.opacity = '1';
  pixelBox.style.left = `${rect.left - overlayRect.left + px * pixelWidth}px`;
  pixelBox.style.top = `${rect.top - overlayRect.top + py * pixelHeight}px`;
  pixelBox.style.width = `${Math.max(pixelWidth, 1)}px`;
  pixelBox.style.height = `${Math.max(pixelHeight, 1)}px`;
}

function renderHoverOverlays(clientX, clientY) {
  const imageRect = imageStage.getBoundingClientRect();
  const whiteRect = whiteStage.getBoundingClientRect();
  const inImage =
    clientX >= imageRect.left &&
    clientX <= imageRect.right &&
    clientY >= imageRect.top &&
    clientY <= imageRect.bottom;
  const inWhite =
    clientX >= whiteRect.left &&
    clientX <= whiteRect.right &&
    clientY >= whiteRect.top &&
    clientY <= whiteRect.bottom;

  let active = null;
  if (inImage) {
    active = 'image';
  } else if (inWhite) {
    active = 'white';
  }

  if (!active) {
    imagePixelBox.style.opacity = '0';
    whitePixelBox.style.opacity = '0';
    if (statusLabel) {
      statusLabel.classList.add('hidden');
    }
    hovered = false;
    return;
  }

  const activeRect = active === 'image' ? imageRect : whiteRect;
  const localX = clientX - activeRect.left;
  const localY = clientY - activeRect.top;
  const scaleX = activeRect.width / loadedWidth;
  const scaleY = activeRect.height / loadedHeight;
  const px = clamp(Math.floor(localX / scaleX), 0, loadedWidth - 1);
  const py = clamp(Math.floor(localY / scaleY), 0, loadedHeight - 1);

  if (!isInsideCircle(px, py)) {
    imagePixelBox.style.opacity = '0';
    whitePixelBox.style.opacity = '0';
    if (statusLabel) {
      statusLabel.classList.add('hidden');
    }
    hovered = false;
    return;
  }

  const sample = active === 'image'
    ? imageCtx.getImageData(px, py, 1, 1).data
    : whiteCtx.getImageData(px, py, 1, 1).data;
  if (sample[3] === 0) {
    imagePixelBox.style.opacity = '0';
    whitePixelBox.style.opacity = '0';
    if (statusLabel) {
      statusLabel.classList.add('hidden');
    }
    hovered = false;
    return;
  }

  paintHoverBox(imagePixelBox, imageStage, imageOverlay, px, py);
  paintHoverBox(whitePixelBox, whiteStage, whiteOverlay, px, py);

  const [r, g, b, a] = sample;
  const alpha = a / 255;
  const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  const rgba = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
  const perimeterIndex = getPerimeterIndex(px, py);
  const isCurrentPanel = active === 'white';

  swatch.style.backgroundColor = rgba;
  colorLabel.textContent = `${hex}  ${rgba}`;
  coordLabel.textContent = perimeterIndex
    ? `x: ${px + 1}, y: ${py + 1}  |  #${perimeterIndex}`
    : `x: ${px + 1}, y: ${py + 1}  |  interior`;
  if (statusLabel) {
    if (isCurrentPanel) {
      const sourceSample = imageCtx.getImageData(px, py, 1, 1).data;
      const same =
        sourceSample[0] === sample[0] &&
        sourceSample[1] === sample[1] &&
        sourceSample[2] === sample[2] &&
        sourceSample[3] === sample[3];
      statusLabel.textContent = same ? 'same' : 'not same';
      statusLabel.classList.remove('hidden');
    } else {
      statusLabel.classList.add('hidden');
    }
  }
  hovered = true;
  lastPointer = { x: clientX, y: clientY };
}

function resetState() {
  imagePixelBox.style.opacity = '0';
  whitePixelBox.style.opacity = '0';
  if (statusLabel) {
    statusLabel.classList.add('hidden');
  }
  imageRangeOverlay.innerHTML = '';
  whiteRangeOverlay.innerHTML = '';
  if (lineAnalytics) {
    lineAnalyticsPanels.innerHTML = '';
  }
  currentPaletteCenters = [];
  currentPaletteKeys = [];
  exportedToValues = [];
  updateExportButton();
  invalidateScoreChart();
  scoreExpanded = false;
  targetLineExpanded = false;
  currentLineExpanded = false;
  stopLoop();
  endDrag();
  panX = 0;
  panY = 0;
  applyPan();
  imageCanvas.style.width = '';
  imageCanvas.style.height = '';
  whiteCanvas.style.width = '';
  whiteCanvas.style.height = '';
  imageStage.style.width = '';
  imageStage.style.height = '';
  whiteStage.style.width = '';
  whiteStage.style.height = '';
  imageStage.parentElement.style.width = '';
  imageStage.parentElement.style.height = '';
  whiteStage.parentElement.style.width = '';
  whiteStage.parentElement.style.height = '';
  imageStage.style.left = '';
  imageStage.style.top = '';
  whiteStage.style.left = '';
  whiteStage.style.top = '';
}

function setRangeBounds() {
  perimeterCount = getPerimeterCount();
  const maxValue = Math.max(1, perimeterCount);
  const maxMinDistance = Math.max(0, Math.floor(maxValue / 2));
  const minDistance = getMinDistanceValue(maxValue);
  let fromValue = wrapPerimeterValue(clampInt(rangeFromInput.value, 1, maxValue, 1), maxValue);
  let toValue = wrapPerimeterValue(clampInt(rangeToInput.value, 1, maxValue, maxValue), maxValue);

  if (getCircularDistance(fromValue, toValue, maxValue) < minDistance) {
    if (rangeLastTouched === 'from') {
      toValue = wrapPerimeterValue(fromValue + minDistance, maxValue);
    } else if (rangeLastTouched === 'to') {
      fromValue = wrapPerimeterValue(toValue - minDistance, maxValue);
    } else {
      toValue = wrapPerimeterValue(fromValue + minDistance, maxValue);
    }
  }

  rangeFromInput.min = '1';
  rangeFromInput.max = String(maxValue);
  rangeToInput.min = String(1);
  rangeToInput.max = String(maxValue);
  if (minDistanceInput) {
    minDistanceInput.max = String(maxMinDistance);
    minDistanceInput.value = String(minDistance);
  }

  rangeFromInput.value = String(fromValue);
  rangeToInput.value = String(toValue);
  rangeFromValue.textContent = String(fromValue);
  rangeToValue.textContent = String(toValue);
}

function setQuantizeMode(mode) {
  quantizeMode = mode;
  modeClosestButton.classList.toggle('active', mode === 'closest');
  modeDitheredButton.classList.toggle('active', mode === 'dithered');

  if (loadedWidth && loadedHeight) {
    quantizeAndRender();
  }
}

function loadSourceFromImage(image) {
  loadedWidth = image.naturalWidth;
  loadedHeight = image.naturalHeight;
  sourceCanvas.width = loadedWidth;
  sourceCanvas.height = loadedHeight;
  sourceCtx.clearRect(0, 0, loadedWidth, loadedHeight);
  sourceCtx.drawImage(image, 0, 0);

  const sourceImageData = sourceCtx.getImageData(0, 0, loadedWidth, loadedHeight);
  const sourceData = sourceImageData.data;

  const perimeter = buildCirclePerimeter(loadedWidth, loadedHeight);
  circleCenterX = perimeter.centerX;
  circleCenterY = perimeter.centerY;
  circleRadius = perimeter.radius;
  perimeterPoints = perimeter.points;
  perimeterLookup = perimeter.lookup;
  perimeterCount = perimeter.count;

  for (let y = 0; y < loadedHeight; y += 1) {
    for (let x = 0; x < loadedWidth; x += 1) {
      if (isInsideCircleAt(x, y)) {
        continue;
      }

      const index = (y * loadedWidth + x) * 4;
      sourceData[index] = 0;
      sourceData[index + 1] = 0;
      sourceData[index + 2] = 0;
      sourceData[index + 3] = 0;
    }
  }

  sourceCtx.putImageData(sourceImageData, 0, 0);
  zoom = 1;
  renderZoom();

  imageCanvas.width = loadedWidth;
  imageCanvas.height = loadedHeight;
  whiteCanvas.width = loadedWidth;
  whiteCanvas.height = loadedHeight;

  const whiteData = whiteCtx.createImageData(loadedWidth, loadedHeight);
  for (let y = 0; y < loadedHeight; y += 1) {
    for (let x = 0; x < loadedWidth; x += 1) {
      if (!isInsideCircleAt(x, y)) {
        continue;
      }

      const index = (y * loadedWidth + x) * 4;
      whiteData.data[index] = 255;
      whiteData.data[index + 1] = 255;
      whiteData.data[index + 2] = 255;
      whiteData.data[index + 3] = 255;
    }
  }
  whiteCtx.putImageData(whiteData, 0, 0);
  invalidateScoreChart();

  showViewer();
  setRangeBounds();
  centerPanels();
  renderAllRangeOverlays();
  colorLabel.textContent = 'Hover a pixel';
  coordLabel.textContent = `${loadedWidth} x ${loadedHeight} image loaded`;
  quantizeAndRender();
}

function quantizeAndRender() {
  if (!loadedWidth || !loadedHeight) {
    resetState();
    return;
  }

  const requestId = ++quantizeRequestId;
  const requested = getPaletteCount();
  const data = sourceCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const result = quantizeImageDataDetailed(data, loadedWidth, loadedHeight, requested, quantizeMode);

  if (!result) {
    rebuildPaletteKeys([]);
    resetState();
    return;
  }

  const { mapped, centers } = result;
  rebuildPaletteKeys(centers);
  imageCanvas.width = loadedWidth;
  imageCanvas.height = loadedHeight;
  imageCtx.putImageData(new ImageData(mapped, loadedWidth, loadedHeight), 0, 0);
  invalidateScoreChart();
  stopLoop();

  if (requestId !== quantizeRequestId) {
    return;
  }

  renderAllRangeOverlays();
}

function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    return;
  }

  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
  }

  currentUrl = URL.createObjectURL(file);
  loaderImage.src = currentUrl;
}

imageInput.addEventListener('change', (event) => {
  const [file] = event.target.files || [];
  handleFile(file);
});

paletteInput.addEventListener('input', quantizeAndRender);

rangeFromInput.addEventListener('input', () => {
  rangeFromInput.dataset.touched = 'true';
  rangeLastTouched = 'from';
  setRangeBounds();
  renderAllRangeOverlays();
});

rangeToInput.addEventListener('input', () => {
  rangeToInput.dataset.touched = 'true';
  rangeLastTouched = 'to';
  setRangeBounds();
  renderAllRangeOverlays();
});

drawLineButton.addEventListener('click', drawDominantColorLine);
if (loopLineButton) {
  loopLineButton.addEventListener('click', toggleLoop);
}
chooseImageButton.addEventListener('click', () => {
  imageInput.click();
});

if (exportButton) {
  exportButton.addEventListener('click', exportToValues);
  updateExportButton();
}

modeClosestButton.addEventListener('click', () => setQuantizeMode('closest'));
modeDitheredButton.addEventListener('click', () => setQuantizeMode('dithered'));

loaderImage.addEventListener('load', () => {
  if (ignoreNextImageLoad) {
    ignoreNextImageLoad = false;
    return;
  }

  loadSourceFromImage(loaderImage);
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', (event) => {
  if (!dropZone.contains(event.relatedTarget)) {
    dropZone.classList.remove('dragover');
  }
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  const [file] = event.dataTransfer.files || [];
  handleFile(file);
});

dropZone.addEventListener('pointermove', (event) => {
  if (dragging) {
    return;
  }
  renderHoverOverlays(event.clientX, event.clientY);
});

dropZone.addEventListener('pointerleave', () => {
  if (dragging) {
    return;
  }
  imagePixelBox.style.opacity = '0';
  whitePixelBox.style.opacity = '0';
  if (statusLabel) {
    statusLabel.classList.add('hidden');
  }
  hovered = false;
});

viewer.addEventListener('pointerdown', (event) => {
  if (!loadedWidth || !loadedHeight || event.button !== 0) {
    return;
  }

  dragging = true;
  dragPointerId = event.pointerId;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragStartPanX = panX;
  dragStartPanY = panY;
  viewer.classList.add('dragging');
  viewer.setPointerCapture(event.pointerId);
  imagePixelBox.style.opacity = '0';
  whitePixelBox.style.opacity = '0';
  event.preventDefault();
});

viewer.addEventListener('pointermove', (event) => {
  if (!dragging || event.pointerId !== dragPointerId) {
    return;
  }

  panX = dragStartPanX + (event.clientX - dragStartX);
  panY = dragStartPanY + (event.clientY - dragStartY);
  applyPan();
  renderAllRangeOverlays();
  if (hovered && lastPointer) {
    renderHoverOverlays(lastPointer.x, lastPointer.y);
  }
  event.preventDefault();
});

viewer.addEventListener('pointerup', (event) => {
  if (event.pointerId !== dragPointerId) {
    return;
  }

  endDrag();
  if (hovered && lastPointer) {
    renderHoverOverlays(lastPointer.x, lastPointer.y);
  }
});

viewer.addEventListener('pointercancel', () => {
  endDrag();
});

dropZone.addEventListener(
  'wheel',
  (event) => {
    if (!loadedWidth || !loadedHeight) {
      return;
    }

    event.preventDefault();
    const whiteRect = whiteStage.getBoundingClientRect();
    const inWhite =
      event.clientX >= whiteRect.left &&
      event.clientX <= whiteRect.right &&
      event.clientY >= whiteRect.top &&
      event.clientY <= whiteRect.bottom;
    const activeStage = inWhite ? whiteStage : imageStage;

    const beforeRect = activeStage.getBoundingClientRect();
    if (beforeRect.width <= 0 || beforeRect.height <= 0) {
      return;
    }

    const anchorX = (event.clientX - beforeRect.left) / beforeRect.width;
    const anchorY = (event.clientY - beforeRect.top) / beforeRect.height;
    const factor = event.deltaY > 0 ? 1 / 1.12 : 1.12;
    const nextZoom = clamp(zoom * factor, zoomMin, zoomMax);

    zoom = nextZoom;
    renderZoom();

    const afterRect = activeStage.getBoundingClientRect();
    const desiredLeft = event.clientX - anchorX * afterRect.width;
    const desiredTop = event.clientY - anchorY * afterRect.height;
    const offsetX = desiredLeft - afterRect.left;
    const offsetY = desiredTop - afterRect.top;
    panX += offsetX;
    panY += offsetY;
    applyPan();
    renderAllRangeOverlays();

    if (hovered && lastPointer) {
      renderHoverOverlays(lastPointer.x, lastPointer.y);
    }
  },
  { passive: false }
);

window.addEventListener('resize', () => {
  if (loadedWidth && loadedHeight && !hovered) {
    centerPanels();
  }

  renderAllRangeOverlays();

  if (hovered && lastPointer) {
    renderHoverOverlays(lastPointer.x, lastPointer.y);
  }
});

function boot() {
  loaderImage.src = defaultImageSrc;
}

boot();
