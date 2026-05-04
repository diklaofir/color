import { oklabToRgb, quantizeImageDataDetailed } from './quantize.js';
import { buildCirclePerimeter, clampInt, isInsideCircle as isInsideCircleGeometry } from './geometry.js';
import { ColorPathOptimizer } from './optimizer.js';

const imageInput = document.getElementById('imageInput');
const chooseImageButton = document.getElementById('chooseImageButton');
const paletteCountInput = document.getElementById('paletteCount');
const linesPerColorInput = document.getElementById('linesPerColor');
const nailCountInput = document.getElementById('nailCount');
const minDistanceInput = document.getElementById('minDistance');
const cellsPerThicknessInput = document.getElementById('cellsPerThickness');
const threadThicknessInput = document.getElementById('threadThickness');
const buildButton = document.getElementById('buildButton');
const refineLoopButton = document.getElementById('refineLoopButton');
const stopButton = document.getElementById('stopButton');
const resetButton = document.getElementById('resetButton');
const exportButton = document.getElementById('exportButton');
const dropZone = document.getElementById('dropZone');
const dropCopy = document.getElementById('dropCopy');
const viewer = document.getElementById('viewer');
const targetCanvas = document.getElementById('targetCanvas');
const currentCanvas = document.getElementById('currentCanvas');
const phaseLabel = document.getElementById('phaseLabel');
const matchLabel = document.getElementById('matchLabel');
const detailLabel = document.getElementById('detailLabel');
const minDistanceValue = document.getElementById('minDistanceValue');
const cellsPerThicknessValue = document.getElementById('cellsPerThicknessValue');
const threadThicknessValue = document.getElementById('threadThicknessValue');
const workingGridValue = document.getElementById('workingGridValue');

const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
const currentCtx = currentCanvas.getContext('2d', { willReadFrequently: true });
const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
const loaderImage = new Image();

const defaultImageSrc = 'mona_lisa.PNG';
const defaultColorCount = 4;
const defaultCellsPerThickness = 1;
const defaultThreadThicknessPercent = 0.3;
const defaultRefineIterations = 500;
const stage2CandidateSamples = 1;
const defaultMinDistanceRatio = 0.1;

let currentUrl = null;
let optimizer = null;
let loadedWidth = 0;
let loadedHeight = 0;
let abortRequested = false;
let running = false;
let refineLoopActive = false;
let currentSourceReady = false;
let reloadQueued = false;
let reloadDebounceHandle = null;

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function clampFloat(value, min, max, fallback) {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function rgbKey(r, g, b) {
  return `${r},${g},${b}`;
}

function getColorCount() {
  return clampInt(paletteCountInput.value, 2, 32, defaultColorCount);
}

function getNailCount() {
  return clampInt(nailCountInput.value, 8, 2048, 256);
}

function getDefaultMinDistance() {
  return Math.max(1, Math.round(getNailCount() * defaultMinDistanceRatio));
}

function getMinDistanceValueSetting() {
  const maxValue = Math.max(1, Math.floor(getNailCount() / 2));
  return clampInt(minDistanceInput.value, 1, maxValue, getDefaultMinDistance());
}

function getCellsPerThickness() {
  return clampInt(cellsPerThicknessInput.value, 1, 8, defaultCellsPerThickness);
}

function getThreadThicknessPercent() {
  return clampFloat(threadThicknessInput.value, 0.1, 0.3, defaultThreadThicknessPercent);
}

function updateMinDistanceReadout() {
  const maxValue = Math.max(1, Math.floor(getNailCount() / 2));
  const minDistance = clampInt(minDistanceInput.value, 1, maxValue, getDefaultMinDistance());
  minDistanceInput.max = String(maxValue);
  minDistanceInput.value = String(minDistance);
  minDistanceValue.textContent = `${minDistance} nails`;
}

function updateResolutionReadouts() {
  const cellsPerThickness = getCellsPerThickness();
  const threadThicknessPercent = getThreadThicknessPercent();
  const requestedSize = Math.round((cellsPerThickness * 200) / threadThicknessPercent);

  cellsPerThicknessValue.textContent = `${cellsPerThickness}x`;
  threadThicknessValue.textContent = `${threadThicknessPercent.toFixed(2)}% of radius`;
  workingGridValue.textContent = `${requestedSize}px`;
  updateMinDistanceReadout();
}

function scheduleSourceReload() {
  if (reloadDebounceHandle !== null) {
    window.clearTimeout(reloadDebounceHandle);
  }

  reloadDebounceHandle = window.setTimeout(() => {
    reloadDebounceHandle = null;
    if (reloadQueued) {
      return;
    }

    reloadQueued = true;
    window.requestAnimationFrame(() => {
      reloadQueued = false;
      if (currentSourceReady && loaderImage.complete && loaderImage.naturalWidth > 0) {
        void loadSourceFromImage(loaderImage);
      }
    });
  }, 250);
}

function cancelPendingReload() {
  if (reloadDebounceHandle !== null) {
    window.clearTimeout(reloadDebounceHandle);
    reloadDebounceHandle = null;
  }
}

function setPhase(text) {
  phaseLabel.textContent = text;
}

function setDetail(text) {
  detailLabel.textContent = text;
}

function updateMatch() {
  const ratio = optimizer ? optimizer.getMatchRatio() : 0;
  matchLabel.textContent = `Match ${formatPercent(ratio)}`;
}

function updateButtons() {
  const canOperate = Boolean(optimizer) && currentSourceReady && !running;
  buildButton.disabled = !canOperate;
  refineLoopButton.disabled = !canOperate && !refineLoopActive;
  resetButton.disabled = !Boolean(optimizer) || running;
  exportButton.disabled = !Boolean(optimizer) || running;
  stopButton.disabled = !running;
  chooseImageButton.disabled = running;
  paletteCountInput.disabled = running;
  linesPerColorInput.disabled = running;
  nailCountInput.disabled = running;
  minDistanceInput.disabled = running;
  cellsPerThicknessInput.disabled = running;
  threadThicknessInput.disabled = running;
  refineLoopButton.textContent = refineLoopActive ? 'Stop refine loop' : 'Refine stage 2 loop';
}

function showViewer() {
  viewer.classList.remove('hidden');
  dropCopy.classList.add('hidden');
}

function hideViewer() {
  viewer.classList.add('hidden');
  dropCopy.classList.remove('hidden');
}

function renderTargetCanvas(mapped, width, height) {
  targetCanvas.width = width;
  targetCanvas.height = height;
  targetCtx.putImageData(new ImageData(mapped, width, height), 0, 0);
}

function renderCurrentCanvas() {
  if (!optimizer) {
    currentCtx.clearRect(0, 0, currentCanvas.width, currentCanvas.height);
    return;
  }

  currentCanvas.width = optimizer.width;
  currentCanvas.height = optimizer.height;
  currentCtx.putImageData(new ImageData(optimizer.getCanvasImageData(), optimizer.width, optimizer.height), 0, 0);
}

function resetWorkspace() {
  cancelPendingReload();
  abortRequested = false;
  running = false;
  refineLoopActive = false;
  optimizer = null;
  loadedWidth = 0;
  loadedHeight = 0;
  currentSourceReady = false;
  targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  currentCtx.clearRect(0, 0, currentCanvas.width, currentCanvas.height);
  hideViewer();
  setPhase('Idle');
  setDetail('Drop an image or choose a file to start.');
  updateMatch();
  updateResolutionReadouts();
  updateButtons();
}

function updateCanvasSizing(width, height) {
  void width;
  void height;
}

function syncLiveOptimizerSettings() {
  if (!optimizer) {
    return;
  }

  optimizer.minDistance = getMinDistanceValueSetting();
}

function buildTargetColors(mapped, width, height, paletteRgb) {
  const lookup = new Map();
  paletteRgb.forEach((rgb, index) => {
    lookup.set(rgbKey(rgb[0], rgb[1], rgb[2]), index);
  });

  const targetColors = new Int16Array(width * height);
  targetColors.fill(-1);

  for (let pixel = 0, offset = 0; pixel < targetColors.length; pixel += 1, offset += 4) {
    if (mapped[offset + 3] < 8) {
      continue;
    }

    const key = rgbKey(mapped[offset], mapped[offset + 1], mapped[offset + 2]);
    const paletteIndex = lookup.get(key);
    if (paletteIndex !== undefined) {
      targetColors[pixel] = paletteIndex;
    }
  }

  return targetColors;
}

function maskOutsideCircle(data, width, height, circle) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isInsideCircleGeometry(x, y, width, height, circle.centerX, circle.centerY, circle.radius)) {
        continue;
      }

      const offset = (y * width + x) * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 0;
    }
  }
}

function prepareOptimizerFromImage(image) {
  abortRequested = false;

  const cellsPerThickness = getCellsPerThickness();
  const threadThicknessPercent = getThreadThicknessPercent();
  const requestedSize = Math.round((cellsPerThickness * 200) / threadThicknessPercent);
  loadedWidth = requestedSize;
  loadedHeight = requestedSize;

  sourceCanvas.width = loadedWidth;
  sourceCanvas.height = loadedHeight;
  sourceCtx.clearRect(0, 0, loadedWidth, loadedHeight);
  const coverScale = Math.max(loadedWidth / image.naturalWidth, loadedHeight / image.naturalHeight);
  const drawWidth = image.naturalWidth * coverScale;
  const drawHeight = image.naturalHeight * coverScale;
  const drawX = (loadedWidth - drawWidth) / 2;
  const drawY = (loadedHeight - drawHeight) / 2;
  sourceCtx.drawImage(image, drawX, drawY, drawWidth, drawHeight);

  const sourceImageData = sourceCtx.getImageData(0, 0, loadedWidth, loadedHeight);
  const sourceData = new Uint8ClampedArray(sourceImageData.data);
  const circle = buildCirclePerimeter(loadedWidth, loadedHeight);
  maskOutsideCircle(sourceData, loadedWidth, loadedHeight, circle);

  const colorCount = getColorCount();
  const quantized = quantizeImageDataDetailed(sourceData, loadedWidth, loadedHeight, colorCount, 'dithered');
  if (!quantized) {
    throw new Error('Quantization failed');
  }

  const paletteRgb = quantized.centers.map((center) => oklabToRgb(center[0], center[1], center[2]));
  const targetColors = buildTargetColors(quantized.mapped, loadedWidth, loadedHeight, paletteRgb);

  renderTargetCanvas(quantized.mapped, loadedWidth, loadedHeight);
  updateCanvasSizing(loadedWidth, loadedHeight);

  optimizer = new ColorPathOptimizer({
    width: loadedWidth,
    height: loadedHeight,
    targetColors,
    paletteRgb,
    perimeterPoints: circle.points,
    circle,
    colorCount,
    linesPerColor: clampInt(linesPerColorInput.value, 1, 100000, 1000),
    nailCount: getNailCount(),
    candidateSamples: 1,
    minDistance: getMinDistanceValueSetting(),
    localSearchRadius: 1,
  });
  syncLiveOptimizerSettings();

  currentSourceReady = true;
  showViewer();
  renderCurrentCanvas();
  updateMatch();
  setPhase('Ready');
  setDetail(`Build stage 1 to generate layered paths. Working grid ${loadedWidth}px by ${loadedHeight}px.`);
  updateButtons();
}

async function loadSourceFromImage(image) {
  try {
    prepareOptimizerFromImage(image);
  } catch (error) {
    resetWorkspace();
    setPhase('Load failed');
    setDetail(error instanceof Error ? error.message : String(error));
  }
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

async function runStage1() {
  if (!optimizer || running) {
    return;
  }

  running = true;
  abortRequested = false;

  try {
    if (loaderImage.complete && loaderImage.naturalWidth > 0) {
      prepareOptimizerFromImage(loaderImage);
    }

    setPhase('Stage 1: building paths');
    setDetail('Choosing local candidates and drawing the initial round-robin paths.');
    updateButtons();

    await optimizer.buildInitialPaths({
      yieldEvery: 2,
      onProgress: (info) => {
        if (abortRequested) {
          throw new Error('aborted');
        }

        if (info.roundIndex % 4 === 0 || info.roundIndex === info.totalRounds) {
          renderCurrentCanvas();
        }

        setPhase(`Stage 1: round ${info.roundIndex}/${info.totalRounds}`);
        updateMatch();
      },
    });

    renderCurrentCanvas();
    updateMatch();
    setPhase('Stage 1 complete');
    setDetail(`The layered paths are in place.\nHighest repeats: ${optimizer.getHighestRepeatCount()}`);
  } catch (error) {
    if (abortRequested || (error instanceof Error && error.message === 'aborted')) {
      setPhase('Stopped');
      setDetail('The current build was stopped.');
    } else {
      setPhase('Stage 1 failed');
      setDetail(error instanceof Error ? error.message : String(error));
    }
  } finally {
    running = false;
    updateButtons();
  }
}

async function runStage2() {
  if (!optimizer || running) {
    return;
  }

  syncLiveOptimizerSettings();
  optimizer.candidateSamples = stage2CandidateSamples;
  const iterations = defaultRefineIterations;
  running = true;
  abortRequested = false;
  setPhase('Stage 2: refining');
  setDetail('Searching a local minimum, then trying one random jump.');
  updateButtons();

  try {
    await optimizer.refineMany({
      iterations,
      yieldEvery: 20,
      onProgress: (info) => {
        if (abortRequested) {
          throw new Error('aborted');
        }

        if (info.iteration % 10 === 0 || info.iteration === info.totalIterations) {
          renderCurrentCanvas();
        }

        setPhase(`Stage 2: iteration ${info.iteration}/${info.totalIterations}`);
        updateMatch();
      },
    });

    renderCurrentCanvas();
    updateMatch();
    setPhase('Stage 2 complete');
    setDetail('Refinement finished.');
  } catch (error) {
    if (abortRequested || (error instanceof Error && error.message === 'aborted')) {
      setPhase('Stopped');
      setDetail('The current refinement was stopped.');
    } else {
      setPhase('Stage 2 failed');
      setDetail(error instanceof Error ? error.message : String(error));
    }
  } finally {
    running = false;
    updateButtons();
  }
}

async function runStage2Loop() {
  if (!optimizer || running) {
    return;
  }

  syncLiveOptimizerSettings();
  optimizer.candidateSamples = stage2CandidateSamples;
  const iterations = defaultRefineIterations;
  running = true;
  refineLoopActive = true;
  abortRequested = false;
  setPhase('Stage 2 loop: refining');
  setDetail('Repeating local refinement until you stop it.');
  updateButtons();

  try {
    while (!abortRequested) {
      const cycle = await optimizer.refineMany({
        iterations,
        yieldEvery: 20,
        onProgress: (info) => {
          if (abortRequested) {
            throw new Error('aborted');
          }

          if (info.iteration % 10 === 0 || info.iteration === info.totalIterations) {
            renderCurrentCanvas();
          }

          setPhase(`Stage 2 loop: iteration ${info.iteration}/${info.totalIterations}`);
          updateMatch();
        },
      });

      renderCurrentCanvas();
      updateMatch();
      setDetail(`Cycle complete. Changed ${cycle.changedCount} moves; delta ${cycle.totalDelta}.`);

      if (abortRequested) {
        break;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    if (abortRequested) {
      setPhase('Stopped');
      setDetail('The refine loop was stopped.');
    } else {
      setPhase('Stage 2 loop complete');
      setDetail('The loop ended.');
    }
  } catch (error) {
    if (abortRequested || (error instanceof Error && error.message === 'aborted')) {
      setPhase('Stopped');
      setDetail('The refine loop was stopped.');
    } else {
      setPhase('Stage 2 loop failed');
      setDetail(error instanceof Error ? error.message : String(error));
    }
  } finally {
    running = false;
    refineLoopActive = false;
    updateButtons();
  }
}

function stopCurrentRun() {
  if (!running) {
    return;
  }

  abortRequested = true;
  setPhase('Stopping...');
  setDetail('Waiting for the current batch to finish.');
  updateButtons();
}

function exportPaths() {
  if (!optimizer) {
    return;
  }

  const payload = {
    width: optimizer.width,
    height: optimizer.height,
    matchRatio: optimizer.getMatchRatio(),
    settings: {
      colorCount: getColorCount(),
      linesPerColor: optimizer.linesPerColor,
      nailCount: optimizer.nailCount,
      minDistance: getMinDistanceValueSetting(),
      localSearchRadius: optimizer.localSearchRadius,
      cellsPerThickness: getCellsPerThickness(),
      threadThicknessPercent: getThreadThicknessPercent(),
      workingSize: loadedWidth,
    },
    paletteRgb: optimizer.paletteRgb,
    paths: optimizer.getPaths(),
  };

  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'color-paths.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function resetGenerationOnly() {
  if (!optimizer) {
    return;
  }

  optimizer.resetSimulation();
  renderCurrentCanvas();
  updateMatch();
  setPhase('Ready');
  setDetail('Canvas reset. Build stage 1 again to generate a fresh sequence.');
}

imageInput.addEventListener('change', (event) => {
  const [file] = event.target.files || [];
  handleFile(file);
});

chooseImageButton.addEventListener('click', () => {
  imageInput.click();
});

paletteCountInput.addEventListener('input', () => {
  updateButtons();
  scheduleSourceReload();
});

buildButton.addEventListener('click', () => {
  void runStage1();
});

refineLoopButton.addEventListener('click', () => {
  if (refineLoopActive) {
    stopCurrentRun();
    return;
  }

  void runStage2Loop();
});

stopButton.addEventListener('click', stopCurrentRun);
resetButton.addEventListener('click', resetGenerationOnly);
exportButton.addEventListener('click', exportPaths);

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

linesPerColorInput.addEventListener('input', updateButtons);
nailCountInput.addEventListener('input', () => {
  updateMinDistanceReadout();
  updateButtons();
});
minDistanceInput.addEventListener('input', () => {
  syncLiveOptimizerSettings();
  updateMinDistanceReadout();
  updateButtons();
});
cellsPerThicknessInput.addEventListener('input', () => {
  updateResolutionReadouts();
  scheduleSourceReload();
});
threadThicknessInput.addEventListener('input', () => {
  updateResolutionReadouts();
  scheduleSourceReload();
});
loaderImage.addEventListener('load', () => {
  void loadSourceFromImage(loaderImage);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    stopCurrentRun();
  }
});

function boot() {
  setPhase('Loading default image');
  setDetail('Use the file picker or drop another image onto the workspace.');
  updateResolutionReadouts();
  loaderImage.src = defaultImageSrc;
  updateButtons();
}

resetWorkspace();
boot();
