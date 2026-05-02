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
  extractLinePixels,
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
const lineAnalytics = document.getElementById('lineAnalytics');
const lineAnalyticsPanels = document.getElementById('lineAnalyticsPanels');
const extractLineButton = document.getElementById('extractLine');
const drawLineButton = document.getElementById('drawLine');
const dropZone = document.getElementById('dropZone');
const dropCopy = document.getElementById('dropCopy');
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
let zoom = 1;
let ignoreNextImageLoad = false;
let quantizeRequestId = 0;
let quantizeMode = 'closest';
let currentPaletteCenters = [];
let currentPaletteKeys = [];
let perimeterPoints = [];
let perimeterLookup = new Map();
let perimeterCount = 1;
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

function rebuildPaletteKeys(centers) {
  currentPaletteCenters = centers || [];
  currentPaletteKeys = currentPaletteCenters.map((center) => {
    const [r, g, b] = oklabToRgb(center[0], center[1], center[2]);
    return rgbKey(r, g, b);
  });
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
}

function renderLineAnalytics() {
  if (!lineAnalyticsPanels || !extractLineButton || !drawLineButton) {
    return;
  }

  if (!loadedWidth || !loadedHeight || perimeterPoints.length === 0 || currentPaletteCenters.length === 0) {
    lineAnalyticsPanels.innerHTML = '';
    extractLineButton.disabled = true;
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
    extractLineButton.disabled = true;
    drawLineButton.disabled = true;
    return;
  }

  const totalPoints = linePoints.length;
  const formatShare = (count) => `${count} (${((count / totalPoints) * 100).toFixed(1)}%)`;

  const paletteLookup = buildPaletteLookup(currentPaletteKeys);
  const imageData = imageCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const whiteData = whiteCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const { imageCounts, whiteCounts, whiteCount } = analyzeLinePoints({
    linePoints,
    width: loadedWidth,
    imageData,
    whiteData,
    paletteLookup,
    paletteCount: currentPaletteCenters.length,
  });

  const imageRows = currentPaletteCenters
    .map((center, index) => `<div class="analytics-row"><span>Color ${index + 1}</span><strong>${formatShare(imageCounts[index])}</strong></div>`)
    .join('');
  const whiteRows =
    currentPaletteCenters
      .map((center, index) => `<div class="analytics-row"><span>Color ${index + 1}</span><strong>${formatShare(whiteCounts[index])}</strong></div>`)
      .join('') + `<div class="analytics-row"><span>White</span><strong>${formatShare(whiteCount)}</strong></div>`;
  const dominantIndex = getDominantColorIndex(imageCounts);
  const nonDominantRightCount =
    whiteCounts.reduce((sum, count, index) => (index === dominantIndex ? sum : sum + count), 0) + whiteCount;
  const diffRows = `<div class="analytics-row"><span>Non-dominant</span><strong>${formatShare(nonDominantRightCount)}</strong></div>`;

  lineAnalyticsPanels.innerHTML = `
    <div class="analytics-panel">
      <div class="analytics-title">Target line</div>
      <div class="analytics-list">${imageRows}</div>
    </div>
    <div class="analytics-panel">
      <div class="analytics-title">White line</div>
      <div class="analytics-list">${whiteRows}</div>
    </div>
    <div class="analytics-panel">
      <div class="analytics-title">Diff</div>
      <div class="analytics-list">${diffRows}</div>
    </div>
  `;
  extractLineButton.disabled = false;
  drawLineButton.disabled = false;
}

function extractCurrentLine() {
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
  if (!linePoints.length) {
    return;
  }

  const sourceData = imageCtx.getImageData(0, 0, loadedWidth, loadedHeight).data;
  const targetImageData = whiteCtx.getImageData(0, 0, loadedWidth, loadedHeight);
  const targetData = targetImageData.data;

  extractLinePixels({
    linePoints,
    width: loadedWidth,
    sourceData,
    targetData,
  });

  whiteCtx.putImageData(targetImageData, 0, 0);

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

function drawHighestDiffLine() {
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
    hovered = false;
    return;
  }

  const sample = active === 'image'
    ? imageCtx.getImageData(px, py, 1, 1).data
    : whiteCtx.getImageData(px, py, 1, 1).data;
  if (sample[3] === 0) {
    imagePixelBox.style.opacity = '0';
    whitePixelBox.style.opacity = '0';
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

  swatch.style.backgroundColor = rgba;
  colorLabel.textContent = `${hex}  ${rgba}`;
  coordLabel.textContent = perimeterIndex
    ? `x: ${px + 1}, y: ${py + 1}  |  #${perimeterIndex}`
    : `x: ${px + 1}, y: ${py + 1}  |  interior`;
  hovered = true;
  lastPointer = { x: clientX, y: clientY };
}

function resetState() {
  imagePixelBox.style.opacity = '0';
  whitePixelBox.style.opacity = '0';
  imageRangeOverlay.innerHTML = '';
  whiteRangeOverlay.innerHTML = '';
  if (lineAnalytics) {
    lineAnalyticsPanels.innerHTML = '';
  }
  currentPaletteCenters = [];
  currentPaletteKeys = [];
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
  rangeFromInput.max = String(maxValue);
  rangeToInput.max = String(maxValue);

  const touched = rangeFromInput.dataset.touched === 'true' || rangeToInput.dataset.touched === 'true';
  const fromValue = clampInt(rangeFromInput.value, 1, maxValue, 1);
  const toValue = clampInt(rangeToInput.value, 1, maxValue, touched ? 1 : maxValue);

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
  setRangeBounds();
  renderAllRangeOverlays();
});

rangeToInput.addEventListener('input', () => {
  rangeToInput.dataset.touched = 'true';
  setRangeBounds();
  renderAllRangeOverlays();
});

extractLineButton.addEventListener('click', extractCurrentLine);
drawLineButton.addEventListener('click', drawHighestDiffLine);

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
