export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return clamp(parsed, min, max);
}

export function getCircleRadius(width, height) {
  if (width === 1 && height === 1) {
    return 0;
  }

  return Math.max(0, Math.min(width, height) / 2 - 0.5);
}

export function isInsideCircle(x, y, width, height, centerX, centerY, radius) {
  if (width <= 0 || height <= 0) {
    return false;
  }

  if (width === 1 && height === 1) {
    return true;
  }

  const dx = x - centerX;
  const dy = y - centerY;
  return Math.sqrt(dx * dx + dy * dy) <= radius + 1e-6;
}

export function isCircleBoundary(x, y, width, height, centerX, centerY, radius) {
  if (!isInsideCircle(x, y, width, height, centerX, centerY, radius)) {
    return false;
  }

  const neighbors = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ];

  return neighbors.some(([nx, ny]) => !isInsideCircle(nx, ny, width, height, centerX, centerY, radius));
}

export function buildCirclePerimeter(width, height) {
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const radius = getCircleRadius(width, height);
  const points = [];
  const lookup = new Map();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isCircleBoundary(x, y, width, height, centerX, centerY, radius)) {
        continue;
      }

      const angle = Math.atan2(x - centerX, centerY - y);
      const normalized = (angle + Math.PI * 2) % (Math.PI * 2);
      const dist = Math.hypot(x - centerX, y - centerY);
      points.push({ x, y, angle: normalized, dist });
    }
  }

  points.sort((a, b) => a.angle - b.angle || a.dist - b.dist || a.x - b.x || a.y - b.y);
  points.forEach((point, index) => {
    lookup.set(`${point.x},${point.y}`, index + 1);
  });

  return {
    centerX,
    centerY,
    radius,
    points,
    lookup,
    count: points.length || 1,
  };
}

export function getLinePoints(x0, y0, x1, y1) {
  const points = [];
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  while (true) {
    points.push({ x, y });
    if (x === x1 && y === y1) {
      break;
    }

    const twiceErr = 2 * err;
    if (twiceErr >= dy) {
      err += dy;
      x += sx;
    }
    if (twiceErr <= dx) {
      err += dx;
      y += sy;
    }
  }

  return points;
}
