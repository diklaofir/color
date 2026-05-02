function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgb(channel) {
  const value = channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return clamp(Math.round(value * 255), 0, 255);
}

function rgbToOklab(r, g, b) {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
  const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
  const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

export function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(blue)];
}

function oklabDistanceSq(a, b) {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

function buildPaletteCenters(data, width, height, requested) {
  const maxSamples = Math.min(24000, Math.max(4000, requested * 1400));
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSamples)));
  const samples = [];

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha < 8) {
        continue;
      }

      samples.push({
        lab: rgbToOklab(data[index], data[index + 1], data[index + 2]),
        weight: alpha / 255,
      });
    }
  }

  if (!samples.length) {
    return null;
  }

  const k = Math.min(requested, samples.length);
  const centers = [samples[(Math.random() * samples.length) | 0].lab.slice()];

  while (centers.length < k) {
    const distances = new Array(samples.length);
    let total = 0;

    for (let i = 0; i < samples.length; i += 1) {
      let best = Infinity;
      for (let j = 0; j < centers.length; j += 1) {
        const distance = oklabDistanceSq(samples[i].lab, centers[j]);
        if (distance < best) {
          best = distance;
        }
      }
      const weighted = best * samples[i].weight;
      distances[i] = weighted;
      total += weighted;
    }

    if (total <= 0) {
      centers.push(samples[(Math.random() * samples.length) | 0].lab.slice());
      continue;
    }

    let threshold = Math.random() * total;
    let chosen = samples[0].lab.slice();
    for (let i = 0; i < distances.length; i += 1) {
      threshold -= distances[i];
      if (threshold <= 0) {
        chosen = samples[i].lab.slice();
        break;
      }
    }
    centers.push(chosen);
  }

  for (let iter = 0; iter < 12; iter += 1) {
    const clusters = Array.from({ length: k }, () => ({
      l: 0,
      a: 0,
      b: 0,
      weight: 0,
    }));

    for (let i = 0; i < samples.length; i += 1) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let j = 0; j < centers.length; j += 1) {
        const distance = oklabDistanceSq(samples[i].lab, centers[j]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = j;
        }
      }

      const cluster = clusters[bestIndex];
      const weight = samples[i].weight;
      cluster.l += samples[i].lab[0] * weight;
      cluster.a += samples[i].lab[1] * weight;
      cluster.b += samples[i].lab[2] * weight;
      cluster.weight += weight;
    }

    for (let i = 0; i < clusters.length; i += 1) {
      if (clusters[i].weight > 0) {
        centers[i] = [
          clusters[i].l / clusters[i].weight,
          clusters[i].a / clusters[i].weight,
          clusters[i].b / clusters[i].weight,
        ];
      } else {
        centers[i] = samples[(Math.random() * samples.length) | 0].lab.slice();
      }
    }
  }

  return centers;
}

function nearestCenterIndex(lab, centers) {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let i = 0; i < centers.length; i += 1) {
    const distance = oklabDistanceSq(lab, centers[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex;
}

export function quantizeImageDataDetailed(data, width, height, requested, mode) {
  const centers = buildPaletteCenters(data, width, height, requested);
  if (!centers || !centers.length) {
    return null;
  }

  const mapped = new Uint8ClampedArray(width * height * 4);

  if (mode === 'dithered') {
    const working = new Float32Array(width * height * 3);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 3) {
      working[p] = data[i];
      working[p + 1] = data[i + 1];
      working[p + 2] = data[i + 2];
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const pixelIndex = (y * width + x) * 3;
        const alpha = data[index + 3];

        if (alpha < 8) {
          mapped[index + 3] = 0;
          continue;
        }

        const r = clamp(Math.round(working[pixelIndex]), 0, 255);
        const g = clamp(Math.round(working[pixelIndex + 1]), 0, 255);
        const b = clamp(Math.round(working[pixelIndex + 2]), 0, 255);
        const lab = rgbToOklab(r, g, b);
        const bestIndex = nearestCenterIndex(lab, centers);
        const [qR, qG, qB] = oklabToRgb(centers[bestIndex][0], centers[bestIndex][1], centers[bestIndex][2]);

        mapped[index] = qR;
        mapped[index + 1] = qG;
        mapped[index + 2] = qB;
        mapped[index + 3] = alpha;

        const errorR = r - qR;
        const errorG = g - qG;
        const errorB = b - qB;

        const diffuse = (dx, dy, factor) => {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            return;
          }

          const neighbor = (ny * width + nx) * 3;
          working[neighbor] += errorR * factor;
          working[neighbor + 1] += errorG * factor;
          working[neighbor + 2] += errorB * factor;
        };

        diffuse(1, 0, 7 / 16);
        diffuse(-1, 1, 3 / 16);
        diffuse(0, 1, 5 / 16);
        diffuse(1, 1, 1 / 16);
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const alpha = data[index + 3];

        if (alpha < 8) {
          mapped[index + 3] = 0;
          continue;
        }

        const lab = rgbToOklab(data[index], data[index + 1], data[index + 2]);
        const bestIndex = nearestCenterIndex(lab, centers);
        const [qR, qG, qB] = oklabToRgb(centers[bestIndex][0], centers[bestIndex][1], centers[bestIndex][2]);

        mapped[index] = qR;
        mapped[index + 1] = qG;
        mapped[index + 2] = qB;
        mapped[index + 3] = alpha;
      }
    }
  }

  return { mapped, centers };
}

export function quantizeImageData(data, width, height, requested, mode) {
  const result = quantizeImageDataDetailed(data, width, height, requested, mode);
  return result ? result.mapped : null;
}
