import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildCirclePerimeter, clamp, isInsideCircle as isInsideCircleGeometry } from './geometry.js';
import { getLinePoints } from './geometry.js';
import { oklabToRgb, quantizeImageDataDetailed } from './quantize.js';

const RULE_NAMES = ['currentDominant', 'targetDominant', 'sameNonDominant', 'otherwise', 'lengthMultiplier'];
const DEFAULT_RULES = {
  currentDominant: 0,
  targetDominant: 1,
  sameNonDominant: -1,
  otherwise: 0,
  lengthMultiplier: 2,
};

function usage() {
  return `
Usage:
  node headless_rules.js --image mona_lisa.PNG --lines 2000 --rules 0,1,-1,0,2 --rules 0,4,-1,0,2

Options:
  --image <path>              PNG input image. Default: mona_lisa.PNG
  --out <dir>                 Output directory. Default: rule-runs
  --lines <count>             Number of drawn lines. Default: 2000
  --palette <count>           Palette color count. Default: 3
  --mode <closest|dithered>   Quantize mode. Default: closest
  --min-distance <count>      Minimum perimeter distance. Default: 20
  --from <index>              Starting perimeter index. Default: 1
  --seed <number>             Deterministic quantize seed. Default: 1
  --rules <a,b,c,d,x>         Rule tuple: currentDominant,targetDominant,sameNonDominant,otherwise,lengthMultiplier
  --base <a,b,c,d,x>          Base rule tuple for --vary. Default: 0,1,-1,0,2
  --vary <name=v1,v2,...>     Expand rules by changing one base rule. Can be repeated.
  --skip-existing             Do not rerun rule sets whose PNG already exists.
  --save-target               Also save the quantized target PNG.
  --line-cache <count>        Cached line geometries. Default: 20000

Examples:
  node headless_rules.js --lines 2000 --rules 0,1,-1,0,2 --rules 0,4,-1,0,2
  node headless_rules.js --base 0,1,-1,0,2 --vary targetDominant=1,4
  node headless_rules.js --base 0,4,-1,0,2 --vary sameNonDominant=-1,-4
`.trim();
}

function parseArgs(argv) {
  const options = {
    image: 'mona_lisa.PNG',
    out: 'rule-runs',
    lines: 2000,
    palette: 3,
    mode: 'closest',
    minDistance: 20,
    from: 1,
    seed: 1,
    rules: [],
    base: null,
    vary: [],
    skipExisting: false,
    saveTarget: false,
    lineCache: 20000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[i];
    };

    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg === '--image') {
      options.image = readValue();
    } else if (arg === '--out') {
      options.out = readValue();
    } else if (arg === '--lines') {
      options.lines = parsePositiveInt(readValue(), '--lines');
    } else if (arg === '--palette') {
      options.palette = parsePositiveInt(readValue(), '--palette');
    } else if (arg === '--mode') {
      options.mode = readValue();
    } else if (arg === '--min-distance') {
      options.minDistance = parseNonNegativeInt(readValue(), '--min-distance');
    } else if (arg === '--from') {
      options.from = parsePositiveInt(readValue(), '--from');
    } else if (arg === '--seed') {
      options.seed = Number(readValue());
      if (!Number.isFinite(options.seed)) {
        throw new Error('--seed must be a number');
      }
    } else if (arg === '--rules') {
      options.rules.push(parseRuleTuple(readValue()));
    } else if (arg === '--base') {
      options.base = parseRuleTuple(readValue());
    } else if (arg === '--vary') {
      options.vary.push(parseVary(readValue()));
    } else if (arg === '--skip-existing') {
      options.skipExisting = true;
    } else if (arg === '--save-target') {
      options.saveTarget = true;
    } else if (arg === '--line-cache') {
      options.lineCache = parsePositiveInt(readValue(), '--line-cache');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['closest', 'dithered'].includes(options.mode)) {
    throw new Error('--mode must be closest or dithered');
  }

  if (options.vary.length > 0) {
    const base = options.base || { ...DEFAULT_RULES };
    for (const variation of options.vary) {
      for (const value of variation.values) {
        options.rules.push({ ...base, [variation.name]: value });
      }
    }
  }

  if (options.rules.length === 0) {
    options.rules.push(options.base || { ...DEFAULT_RULES });
  }

  return options;
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseRuleTuple(value) {
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== RULE_NAMES.length || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Rule tuple must be ${RULE_NAMES.join(',')}`);
  }

  return Object.fromEntries(RULE_NAMES.map((name, index) => [name, parts[index]]));
}

function parseVary(value) {
  const [name, rawValues] = value.split('=');
  if (!RULE_NAMES.includes(name) || !rawValues) {
    throw new Error(`--vary must look like targetDominant=1,4. Names: ${RULE_NAMES.join(', ')}`);
  }

  const values = rawValues.split(',').map((part) => Number(part.trim()));
  if (!values.length || values.some((part) => !Number.isFinite(part))) {
    throw new Error(`--vary ${name} has invalid values`);
  }

  return { name, values };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function withSeededRandom(seed, callback) {
  const previousRandom = Math.random;
  Math.random = mulberry32(Math.trunc(seed));
  try {
    return callback();
  } finally {
    Math.random = previousRandom;
  }
}

function readPng(filePath) {
  const bytes = fs.readFileSync(filePath);
  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) {
      throw new Error(`${filePath} is not a PNG file`);
    }
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error('Only non-interlaced 8-bit PNGs are supported');
      }
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!width || !height || !idat.length) {
    throw new Error(`${filePath} is missing PNG image data`);
  }

  const channels = getPngChannels(colorType);
  const bytesPerPixel = channels;
  const scanlineLength = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(height * scanlineLength);
  let inputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const rowStart = y * scanlineLength;
    const previousRowStart = (y - 1) * scanlineLength;

    for (let x = 0; x < scanlineLength; x += 1) {
      const rawByte = inflated[inputOffset + x];
      const left = x >= bytesPerPixel ? raw[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? raw[previousRowStart + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? raw[previousRowStart + x - bytesPerPixel] : 0;

      if (filter === 0) {
        raw[rowStart + x] = rawByte;
      } else if (filter === 1) {
        raw[rowStart + x] = (rawByte + left) & 0xff;
      } else if (filter === 2) {
        raw[rowStart + x] = (rawByte + up) & 0xff;
      } else if (filter === 3) {
        raw[rowStart + x] = (rawByte + Math.floor((left + up) / 2)) & 0xff;
      } else if (filter === 4) {
        raw[rowStart + x] = (rawByte + paeth(left, up, upLeft)) & 0xff;
      } else {
        throw new Error(`Unsupported PNG filter ${filter}`);
      }
    }

    inputOffset += scanlineLength;
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0, source = 0, target = 0; pixel < width * height; pixel += 1, target += 4) {
    if (colorType === 0) {
      const gray = raw[source];
      source += 1;
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = transparency && transparency.length >= 2 && gray === transparency.readUInt16BE(0) ? 0 : 255;
    } else if (colorType === 2) {
      const r = raw[source];
      const g = raw[source + 1];
      const b = raw[source + 2];
      source += 3;
      rgba[target] = r;
      rgba[target + 1] = g;
      rgba[target + 2] = b;
      rgba[target + 3] =
        transparency &&
        transparency.length >= 6 &&
        r === transparency.readUInt16BE(0) &&
        g === transparency.readUInt16BE(2) &&
        b === transparency.readUInt16BE(4)
          ? 0
          : 255;
    } else if (colorType === 3) {
      if (!palette) {
        throw new Error('Indexed PNG is missing PLTE');
      }
      const paletteIndex = raw[source];
      source += 1;
      rgba[target] = palette[paletteIndex * 3] || 0;
      rgba[target + 1] = palette[paletteIndex * 3 + 1] || 0;
      rgba[target + 2] = palette[paletteIndex * 3 + 2] || 0;
      rgba[target + 3] = transparency && paletteIndex < transparency.length ? transparency[paletteIndex] : 255;
    } else if (colorType === 4) {
      const gray = raw[source];
      const alpha = raw[source + 1];
      source += 2;
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = alpha;
    } else if (colorType === 6) {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] = raw[source + 3];
      source += 4;
    }
  }

  return { width, height, data: rgba };
}

function getPngChannels(colorType) {
  if (colorType === 0 || colorType === 3) {
    return 1;
  }
  if (colorType === 2) {
    return 3;
  }
  if (colorType === 4) {
    return 2;
  }
  if (colorType === 6) {
    return 4;
  }
  throw new Error(`Unsupported PNG color type ${colorType}`);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

function writePng(filePath, width, height, data) {
  const chunks = [];
  chunks.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(makeChunk('IHDR', ihdr));

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, row + 1);
  }

  chunks.push(makeChunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));
  fs.writeFileSync(filePath, Buffer.concat(chunks));
}

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rgbKey(r, g, b) {
  return `${r},${g},${b}`;
}

function buildPaletteKeys(centers) {
  return centers.map((center) => {
    const [r, g, b] = oklabToRgb(center[0], center[1], center[2]);
    return rgbKey(r, g, b);
  });
}

function prepareTarget(source, paletteCount, mode, seed) {
  const perimeter = buildCirclePerimeter(source.width, source.height);
  const sourceData = new Uint8ClampedArray(source.data);

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (isInsideCircleGeometry(x, y, source.width, source.height, perimeter.centerX, perimeter.centerY, perimeter.radius)) {
        continue;
      }

      const index = (y * source.width + x) * 4;
      sourceData[index] = 0;
      sourceData[index + 1] = 0;
      sourceData[index + 2] = 0;
      sourceData[index + 3] = 0;
    }
  }

  const quantized = withSeededRandom(seed, () =>
    quantizeImageDataDetailed(sourceData, source.width, source.height, paletteCount, mode)
  );
  if (!quantized) {
    throw new Error('Quantization failed');
  }

  const paletteKeys = buildPaletteKeys(quantized.centers);
  const paletteLookup = new Map();
  paletteKeys.forEach((key, index) => paletteLookup.set(key, index));

  const targetIndexByPixel = new Int16Array(source.width * source.height);
  targetIndexByPixel.fill(-1);
  for (let pixel = 0, i = 0; pixel < targetIndexByPixel.length; pixel += 1, i += 4) {
    if (quantized.mapped[i + 3] < 8) {
      continue;
    }

    const paletteIndex = paletteLookup.get(rgbKey(quantized.mapped[i], quantized.mapped[i + 1], quantized.mapped[i + 2]));
    if (paletteIndex !== undefined) {
      targetIndexByPixel[pixel] = paletteIndex;
    }
  }

  return {
    ...source,
    circle: perimeter,
    mapped: quantized.mapped,
    paletteKeys,
    targetIndexByPixel,
  };
}

class LineCache {
  constructor(target, maxEntries) {
    this.target = target;
    this.maxEntries = maxEntries;
    this.cache = new Map();
  }

  get(fromValue, toValue) {
    const startValue = Math.min(fromValue, toValue);
    const endValue = Math.max(fromValue, toValue);
    const key = `${startValue}:${endValue}`;
    let cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const startPoint = this.target.circle.points[startValue - 1];
    const endPoint = this.target.circle.points[endValue - 1];
    if (!startPoint || !endPoint) {
      cached = emptyLineContext();
      this.cache.set(key, cached);
      return cached;
    }

    const allPixels = [];
    const targetIndices = [];
    const imageCounts = Array.from({ length: this.target.paletteKeys.length }, () => 0);
    for (const point of getLinePoints(startPoint.x, startPoint.y, endPoint.x, endPoint.y)) {
      if (
        !isInsideCircleGeometry(
          point.x,
          point.y,
          this.target.width,
          this.target.height,
          this.target.circle.centerX,
          this.target.circle.centerY,
          this.target.circle.radius
        )
      ) {
        continue;
      }

      const pixelIndex = point.y * this.target.width + point.x;
      const targetIndex = this.target.targetIndexByPixel[pixelIndex];
      allPixels.push(pixelIndex);
      targetIndices.push(targetIndex);
      if (targetIndex >= 0) {
        imageCounts[targetIndex] += 1;
      }
    }

    const dominantIndex = getDominantColorIndex(imageCounts);
    const lineLength = Math.max(1, Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y));
    const maxLength = Math.max(1, this.target.circle.radius * 2);
    const lengthRatio = clamp((lineLength - 1) / Math.max(1, maxLength - 1), 0, 1);

    cached = {
      allPixels: Int32Array.from(allPixels),
      targetIndices: Int16Array.from(targetIndices),
      dominantIndex,
      lengthRatio,
    };
    this.cache.set(key, cached);
    this.evict();
    return cached;
  }

  evict() {
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }
}

function emptyLineContext() {
  return {
    allPixels: new Int32Array(0),
    targetIndices: new Int16Array(0),
    dominantIndex: 0,
    lengthRatio: 0,
  };
}

function getDominantColorIndex(counts) {
  let bestIndex = 0;
  let bestCount = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] > bestCount) {
      bestCount = counts[i];
      bestIndex = i;
    }
  }
  return bestIndex;
}

function getPairScore(targetIndex, currentIndex, dominantIndex, rules) {
  if (currentIndex === dominantIndex) {
    return rules.currentDominant;
  }
  if (targetIndex === dominantIndex) {
    return rules.targetDominant;
  }
  if (currentIndex === targetIndex) {
    return rules.sameNonDominant;
  }
  return rules.otherwise;
}

function getLengthMultiplier(line, rules) {
  const effectiveMultiplier = Math.max(1, rules.lengthMultiplier);
  return 1 + (effectiveMultiplier - 1) * line.lengthRatio;
}

function createInitialCurrent(target) {
  const current = new Int16Array(target.width * target.height);
  current.fill(-2);

  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      if (isInsideCircleGeometry(x, y, target.width, target.height, target.circle.centerX, target.circle.centerY, target.circle.radius)) {
        current[y * target.width + x] = -1;
      }
    }
  }

  return current;
}

function scoreLine(line, current, rules) {
  let lineScore = 0;
  let currentDominantCount = 0;

  for (let i = 0; i < line.allPixels.length; i += 1) {
    const targetIndex = line.targetIndices[i];
    const currentIndex = current[line.allPixels[i]];

    if (currentIndex === line.dominantIndex) {
      currentDominantCount += 1;
    }

    if (targetIndex < 0) {
      continue;
    }

    lineScore += getPairScore(targetIndex, currentIndex, line.dominantIndex, rules);
  }

  return {
    score: lineScore * getLengthMultiplier(line, rules),
    isFullyCurrentDominantLine: line.allPixels.length > 0 && currentDominantCount === line.allPixels.length,
  };
}

function simulate(target, lineCache, rules, options) {
  const current = createInitialCurrent(target);
  const toValues = [];
  const perimeterCount = target.circle.count;
  const minDistance = Math.min(options.minDistance, Math.floor(perimeterCount / 2));
  let fromValue = clamp(Math.trunc(options.from), 1, perimeterCount);

  for (let step = 0; step < options.lines; step += 1) {
    let highestScore = Number.NEGATIVE_INFINITY;
    let highestToValue = 1;
    let bestEligibleScore = Number.NEGATIVE_INFINITY;
    let bestEligibleToValue = 1;

    for (let toValue = 1; toValue <= perimeterCount; toValue += 1) {
      const circularDistance = Math.abs(fromValue - toValue);
      const lineDistance = Math.min(circularDistance, perimeterCount - circularDistance);
      const line = lineCache.get(fromValue, toValue);
      const { score, isFullyCurrentDominantLine } = scoreLine(line, current, rules);

      if (score > highestScore) {
        highestScore = score;
        highestToValue = toValue;
      }

      if (lineDistance >= minDistance && !isFullyCurrentDominantLine && score > bestEligibleScore) {
        bestEligibleScore = score;
        bestEligibleToValue = toValue;
      }
    }

    const toValue = bestEligibleScore !== Number.NEGATIVE_INFINITY ? bestEligibleToValue : highestToValue;
    const selectedLine = lineCache.get(fromValue, toValue);
    for (const pixelIndex of selectedLine.allPixels) {
      current[pixelIndex] = selectedLine.dominantIndex;
    }

    toValues.push(toValue);
    fromValue = toValue;

    if ((step + 1) % 250 === 0 || step + 1 === options.lines) {
      process.stdout.write(`  ${step + 1}/${options.lines}\r`);
    }
  }
  process.stdout.write(' '.repeat(24) + '\r');

  return {
    current,
    metrics: computeMetrics(target, current),
    toValues,
  };
}

function computeMetrics(target, current) {
  let comparable = 0;
  let matched = 0;
  let whiteRemaining = 0;
  let wrongPainted = 0;
  let painted = 0;

  for (let pixelIndex = 0; pixelIndex < current.length; pixelIndex += 1) {
    if (current[pixelIndex] === -2) {
      continue;
    }

    const targetIndex = target.targetIndexByPixel[pixelIndex];
    if (targetIndex >= 0) {
      comparable += 1;
      if (current[pixelIndex] === targetIndex) {
        matched += 1;
      } else if (current[pixelIndex] === -1) {
        whiteRemaining += 1;
      } else {
        wrongPainted += 1;
      }
    }

    if (current[pixelIndex] >= 0) {
      painted += 1;
    }
  }

  return {
    comparable,
    matched,
    matchedRatio: comparable > 0 ? matched / comparable : 0,
    painted,
    whiteRemaining,
    wrongPainted,
  };
}

function renderCurrentPng(target, current) {
  const rgba = new Uint8ClampedArray(target.width * target.height * 4);
  const paletteRgb = target.paletteKeys.map((key) => key.split(',').map((value) => Number.parseInt(value, 10)));

  for (let pixelIndex = 0, dataIndex = 0; pixelIndex < current.length; pixelIndex += 1, dataIndex += 4) {
    const currentIndex = current[pixelIndex];
    if (currentIndex === -2) {
      rgba[dataIndex + 3] = 0;
    } else if (currentIndex === -1) {
      rgba[dataIndex] = 255;
      rgba[dataIndex + 1] = 255;
      rgba[dataIndex + 2] = 255;
      rgba[dataIndex + 3] = 255;
    } else {
      const [r, g, b] = paletteRgb[currentIndex] || [0, 0, 0];
      rgba[dataIndex] = r;
      rgba[dataIndex + 1] = g;
      rgba[dataIndex + 2] = b;
      rgba[dataIndex + 3] = 255;
    }
  }

  return rgba;
}

function ruleFileStem(rules) {
  return RULE_NAMES.map((name) => formatRuleValue(rules[name])).join('_');
}

function formatRuleValue(value) {
  return Object.is(value, -0) ? '0' : String(value);
}

function humanRuleTuple(rules) {
  return RULE_NAMES.map((name) => rules[name]).join(',');
}

function uniqueRules(rules) {
  const seen = new Set();
  const deduped = [];
  for (const rule of rules) {
    const key = humanRuleTuple(rule);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(rule);
  }
  return deduped;
}

function writeToValues(filePath, toValues) {
  fs.writeFileSync(filePath, `${toValues.length}\n${toValues.join('\n')}\n`, 'utf8');
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const imagePath = path.resolve(options.image);
  const outputDir = path.resolve(options.out);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Reading ${imagePath}`);
  const source = readPng(imagePath);
  console.log(`Preparing ${source.width}x${source.height}, palette=${options.palette}, mode=${options.mode}, seed=${options.seed}`);
  const target = prepareTarget(source, options.palette, options.mode, options.seed);
  const lineCache = new LineCache(target, options.lineCache);
  const rules = uniqueRules(options.rules);

  if (options.saveTarget) {
    writePng(path.join(outputDir, 'target_quantized.png'), target.width, target.height, target.mapped);
  }

  const rows = [];
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    const stem = ruleFileStem(rule);
    const pngPath = path.join(outputDir, `${stem}.png`);
    const toValuesPath = path.join(outputDir, `${stem}.to-values.txt`);
    console.log(`[${i + 1}/${rules.length}] ${humanRuleTuple(rule)} -> ${path.basename(pngPath)}`);

    let metrics = null;
    if (options.skipExisting && fs.existsSync(pngPath)) {
      console.log('  skipped existing PNG');
      metrics = {};
    } else {
      const result = simulate(target, lineCache, rule, options);
      metrics = result.metrics;
      writePng(pngPath, target.width, target.height, renderCurrentPng(target, result.current));
      writeToValues(toValuesPath, result.toValues);
      console.log(
        `  match=${(metrics.matchedRatio * 100).toFixed(2)}% matched=${metrics.matched} wrong=${metrics.wrongPainted} white=${metrics.whiteRemaining}`
      );
    }

    rows.push({
      file: path.basename(pngPath),
      rules: humanRuleTuple(rule),
      ...Object.fromEntries(RULE_NAMES.map((name) => [name, rule[name]])),
      ...metrics,
    });
  }

  const headers = [
    'file',
    'rules',
    ...RULE_NAMES,
    'matchedRatio',
    'matched',
    'comparable',
    'painted',
    'wrongPainted',
    'whiteRemaining',
  ];
  const csv = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] ?? '')).join(',')),
  ].join('\n');
  fs.writeFileSync(path.join(outputDir, 'summary.csv'), `${csv}\n`, 'utf8');
  console.log(`Wrote ${outputDir}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
