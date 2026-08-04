import { requireContract as invariant } from "./errors.js";

const BASIS_EPSILON = 1e-9;
const TRIANGLE_BLEED = 0.75;
const TRIANGLE_CANONICAL_SIZE = 32;

function roundDecimal(value, decimals) {
  if (Object.is(value, 0) || Object.is(value, -0)) return "0";
  if (value === 1) return "1";
  if (value === -1) return "-1";
  const scale = 10 ** decimals;
  const next = Math.round(value * scale) / scale;
  return Object.is(next, 0) || Object.is(next, -0) ? "0" : String(next);
}

function affineTransform(values, decimals) {
  const rounded = values.map((value) => roundDecimal(value, decimals));
  return `matrix3d(${rounded[0]},${rounded[1]},${rounded[2]},0,`
    + `${rounded[3]},${rounded[4]},${rounded[5]},0,`
    + `${rounded[6]},${rounded[7]},${rounded[8]},0,`
    + `${rounded[9]},${rounded[10]},${rounded[11]},1)`;
}

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 2) {
    const next = (index + 2) % points.length;
    area += points[index] * points[next + 1] - points[index + 1] * points[next];
  }
  return area / 2;
}

function convex(points) {
  let sign = 0;
  const count = points.length / 2;
  for (let index = 0; index < count; index += 1) {
    const a = index * 2;
    const b = ((index + 1) % count) * 2;
    const c = ((index + 2) % count) * 2;
    const cross = (points[b] - points[a]) * (points[c + 1] - points[b + 1])
      - (points[b + 1] - points[a + 1]) * (points[c] - points[b]);
    if (Math.abs(cross) <= BASIS_EPSILON) return false;
    const next = Math.sign(cross);
    if (sign === 0) sign = next;
    else if (next !== sign) return false;
  }
  return true;
}

function intersect(a0x, a0y, a1x, a1y, b0x, b0y, b1x, b1y) {
  const rx = a1x - a0x;
  const ry = a1y - a0y;
  const sx = b1x - b0x;
  const sy = b1y - b0y;
  const determinant = rx * sy - ry * sx;
  if (Math.abs(determinant) <= BASIS_EPSILON) return null;
  const qx = b0x - a0x;
  const qy = b0y - a0y;
  const amount = (qx * sy - qy * sx) / determinant;
  return [a0x + amount * rx, a0y + amount * ry];
}

function radialExpansion(points, amount) {
  let centerX = 0;
  let centerY = 0;
  const count = points.length / 2;
  for (let index = 0; index < points.length; index += 2) {
    centerX += points[index];
    centerY += points[index + 1];
  }
  centerX /= count;
  centerY /= count;
  const output = points.slice();
  for (let index = 0; index < output.length; index += 2) {
    const dx = output[index] - centerX;
    const dy = output[index + 1] - centerY;
    const length = Math.hypot(dx, dy);
    if (length <= BASIS_EPSILON) continue;
    output[index] += dx / length * amount;
    output[index + 1] += dy / length * amount;
  }
  return output;
}

function offsetByEdges(points, amounts) {
  const count = points.length / 2;
  const maximum = Math.max(0, ...amounts);
  if (maximum <= 0) return points;
  if (amounts.every((amount) => Math.abs(amount - amounts[0]) <= BASIS_EPSILON)) {
    if (!convex(points) || Math.abs(signedArea(points)) <= BASIS_EPSILON) {
      return radialExpansion(points, amounts[0]);
    }
  } else if (!convex(points) || Math.abs(signedArea(points)) <= BASIS_EPSILON) {
    return points;
  }
  const outward = signedArea(points) > 0 ? 1 : -1;
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const a = index * 2;
    const b = ((index + 1) % count) * 2;
    const dx = points[b] - points[a];
    const dy = points[b + 1] - points[a + 1];
    const length = Math.hypot(dx, dy);
    if (length <= BASIS_EPSILON) return amounts.every((amount) => amount === amounts[0])
      ? radialExpansion(points, amounts[0])
      : points;
    const ox = outward * dy / length * amounts[index];
    const oy = outward * -dx / length * amounts[index];
    lines.push([
      points[a] + ox,
      points[a + 1] + oy,
      points[b] + ox,
      points[b + 1] + oy,
    ]);
  }
  const output = [];
  const maximumMiter = Math.max(2, maximum * 4);
  for (let index = 0; index < count; index += 1) {
    const previous = lines[(index + count - 1) % count];
    const next = lines[index];
    const point = intersect(...previous, ...next);
    if (!point) return amounts.every((amount) => amount === amounts[0])
      ? radialExpansion(points, amounts[0])
      : points;
    const source = index * 2;
    const dx = point[0] - points[source];
    const dy = point[1] - points[source + 1];
    const miter = Math.hypot(dx, dy);
    if (miter > maximumMiter) {
      output.push(
        points[source] + dx / miter * maximumMiter,
        points[source + 1] + dy / miter * maximumMiter,
      );
    } else output.push(point[0], point[1]);
  }
  return output;
}

function safeBleed(points, edgeIndex, requested) {
  if (!(requested > 0)) return 0;
  const count = points.length / 2;
  const a = edgeIndex * 2;
  const b = ((edgeIndex + 1) % count) * 2;
  const dx = points[b] - points[a];
  const dy = points[b + 1] - points[a + 1];
  const length = Math.hypot(dx, dy);
  if (length <= 1e-3) return 0;
  const limits = [];
  let opposite = Number.POSITIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    if (index === edgeIndex || index === (edgeIndex + 1) % count) continue;
    const point = index * 2;
    const distance = Math.abs(
      (points[point] - points[a]) * dy - (points[point + 1] - points[a + 1]) * dx,
    ) / length;
    if (distance > 1e-3) opposite = Math.min(opposite, distance);
  }
  if (Number.isFinite(opposite)) limits.push(opposite * 0.5);
  const previous = ((edgeIndex + count - 1) % count) * 2;
  const after = ((edgeIndex + 2) % count) * 2;
  const previousX = points[previous] - points[a];
  const previousY = points[previous + 1] - points[a + 1];
  const afterX = points[after] - points[b];
  const afterY = points[after + 1] - points[b + 1];
  const previousLength = Math.hypot(previousX, previousY);
  const afterLength = Math.hypot(afterX, afterY);
  if (previousLength > 1e-3) {
    const sine = Math.abs(dx * previousY - dy * previousX) / (length * previousLength);
    if (sine > 1e-3) limits.push(previousLength * sine);
  }
  if (afterLength > 1e-3) {
    const sine = Math.abs(-dx * afterY + dy * afterX) / (length * afterLength);
    if (sine > 1e-3) limits.push(afterLength * sine);
  }
  const finite = limits.filter((value) => Number.isFinite(value) && value > 0);
  return finite.length === 0 ? requested : Math.max(0, Math.min(requested, ...finite));
}

function edgeIndex(a, b) {
  if ((a + 1) % 3 === b) return a;
  if ((b + 1) % 3 === a) return b;
  return -1;
}

function offsetStableTriangle(left, right, height, amount) {
  const baseWidth = left + right;
  if (!(amount > 0) || height <= BASIS_EPSILON || baseWidth <= BASIS_EPSILON
    || !Number.isFinite(left + right + height + amount)) {
    return offsetByEdges([left, 0, 0, height, baseWidth, height], [amount, amount, amount]);
  }
  const leftLength = Math.hypot(left, height);
  const rightLength = Math.hypot(right, height);
  if (leftLength <= BASIS_EPSILON || rightLength <= BASIS_EPSILON) {
    return offsetByEdges([left, 0, 0, height, baseWidth, height], [amount, amount, amount]);
  }
  const leftOffsetX = -amount * height / leftLength;
  const leftOffsetY = -amount * left / leftLength;
  const rightOffsetX = amount * height / rightLength;
  const rightOffsetY = -amount * right / rightLength;
  const apexLineLeftX = left + leftOffsetX;
  const apexLineLeftY = leftOffsetY;
  const apexLineRightX = baseWidth + rightOffsetX;
  const apexLineRightY = height + rightOffsetY;
  const determinant = -height * baseWidth;
  if (Math.abs(determinant) <= BASIS_EPSILON) {
    return offsetByEdges([left, 0, 0, height, baseWidth, height], [amount, amount, amount]);
  }
  const qx = apexLineLeftX - apexLineRightX;
  const qy = apexLineLeftY - apexLineRightY;
  const distance = (qx * height + qy * left) / determinant;
  let apexX = apexLineRightX - distance * right;
  let apexY = apexLineRightY - distance * height;
  let baseLeftX = -amount * (left + leftLength) / height;
  let baseLeftY = height + amount;
  let baseRightX = baseWidth + amount * (right + rightLength) / height;
  let baseRightY = baseLeftY;
  const maximumMiter = Math.max(2, amount * 4);
  const apexDx = apexX - left;
  const apexDy = apexY;
  const apexMiter = Math.hypot(apexDx, apexDy);
  if (apexMiter > maximumMiter) {
    apexX = left + apexDx / apexMiter * maximumMiter;
    apexY = apexDy / apexMiter * maximumMiter;
  }
  const leftMiter = Math.hypot(baseLeftX, amount);
  if (leftMiter > maximumMiter) {
    baseLeftX = baseLeftX / leftMiter * maximumMiter;
    baseLeftY = height + amount / leftMiter * maximumMiter;
  }
  const rightDelta = baseRightX - baseWidth;
  const rightMiter = Math.hypot(rightDelta, amount);
  if (rightMiter > maximumMiter) {
    baseRightX = baseWidth + rightDelta / rightMiter * maximumMiter;
    baseRightY = height + amount / rightMiter * maximumMiter;
  }
  return [apexX, apexY, baseLeftX, baseLeftY, baseRightX, baseRightY];
}

function expandedTriangle(left, right, height, basis, mask, fallback, shared) {
  const points = [left, 0, 0, height, left + right, height];
  if (mask === 0) return offsetStableTriangle(left, right, height, fallback);
  const pairs = [[basis[2], basis[0]], [basis[0], basis[1]], [basis[1], basis[2]]];
  const amounts = pairs.map(([from, to], local) => {
    const edge = edgeIndex(from, to);
    return edge >= 0 && (mask & (1 << edge)) !== 0 ? safeBleed(points, local, shared) : 0;
  });
  return offsetByEdges(points, amounts);
}

function validBasis(value) {
  return Array.isArray(value)
    && value.length === 3
    && value.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 2)
    && ((value[0] === 0 && value[1] === 1 && value[2] === 2)
      || (value[0] === 1 && value[1] === 2 && value[2] === 0)
      || (value[0] === 2 && value[1] === 0 && value[2] === 1));
}

function computedTransform(points, plan, triangle, basisHint) {
  const [p0, p1, p2] = points;
  const e10 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e20 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  let normal = [
    -(e10[1] * e20[2] - e10[2] * e20[1]),
    -(e10[2] * e20[0] - e10[0] * e20[2]),
    -(e10[0] * e20[1] - e10[1] * e20[0]),
  ];
  const normalLength = Math.hypot(...normal);
  if (normalLength <= BASIS_EPSILON) return null;
  normal = normal.map((value) => value / normalLength);
  let basis = validBasis(basisHint) ? basisHint : [0, 1, 2];
  if (!validBasis(basisHint)) {
    const lengths = [
      e10[0] ** 2 + e10[1] ** 2 + e10[2] ** 2,
      (p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2 + (p2[2] - p1[2]) ** 2,
      (p0[0] - p2[0]) ** 2 + (p0[1] - p2[1]) ** 2 + (p0[2] - p2[2]) ** 2,
    ];
    if (lengths[1] > lengths[0]) basis = [1, 2, 0];
    if (lengths[2] > lengths[basis[0]]) basis = [2, 0, 1];
  }
  const [a, b, c] = basis;
  const av = points[a];
  const bv = points[b];
  const cv = points[c];
  const delta = [bv[0] - av[0], bv[1] - av[1], bv[2] - av[2]];
  const baseLength = Math.hypot(...delta);
  if (baseLength <= BASIS_EPSILON) {
    return basisHint ? computedTransform(points, plan, triangle, null) : null;
  }
  const x = delta.map((value) => value / baseLength);
  const apexX = (cv[0] - av[0]) * x[0] + (cv[1] - av[1]) * x[1] + (cv[2] - av[2]) * x[2];
  const y = [
    normal[1] * x[2] - normal[2] * x[1],
    normal[2] * x[0] - normal[0] * x[2],
    normal[0] * x[1] - normal[1] * x[0],
  ];
  const height = normalLength / baseLength;
  if (height <= BASIS_EPSILON) return basisHint ? computedTransform(points, plan, triangle, null) : null;
  const left = Math.max(0, Math.min(baseLength, apexX));
  const right = Math.max(0, baseLength - left);
  const expanded = expandedTriangle(
    left,
    right,
    height,
    basis,
    plan.seamEdgeMask,
    triangle.fallbackAmount ?? TRIANGLE_BLEED,
    triangle.sharedEdgeAmount ?? TRIANGLE_BLEED,
  );
  const baseY = (expanded[3] + expanded[5]) / 2;
  const leftPixels = expanded[0] - expanded[2];
  const rightPixels = expanded[4] - expanded[0];
  const heightPixels = baseY - expanded[1];
  if (!(leftPixels > BASIS_EPSILON && rightPixels > BASIS_EPSILON && heightPixels > BASIS_EPSILON)
    || !Number.isFinite(leftPixels + rightPixels + heightPixels)) {
    return basisHint ? computedTransform(points, plan, triangle, null) : null;
  }
  const baseWidth = leftPixels + rightPixels;
  const xScale = baseWidth / TRIANGLE_CANONICAL_SIZE;
  const yXScale = (rightPixels - leftPixels) * 0.5 / TRIANGLE_CANONICAL_SIZE;
  const yYScale = heightPixels / TRIANGLE_CANONICAL_SIZE;
  const txXOffset = expanded[0] - left - baseWidth * 0.5;
  const txYOffset = expanded[1];
  const values = [
    x[0] * xScale, x[1] * xScale, x[2] * xScale,
    x[0] * yXScale + y[0] * yYScale,
    x[1] * yXScale + y[1] * yYScale,
    x[2] * yXScale + y[2] * yYScale,
    ...normal,
    cv[0] + x[0] * txXOffset + y[0] * txYOffset,
    cv[1] + x[1] * txXOffset + y[1] * txYOffset,
    cv[2] + x[2] * txXOffset + y[2] * txYOffset,
  ];
  return affineTransform(values, plan.matrixDecimals);
}

function fitTransform(transform, plan) {
  if (plan.width === plan.canonicalSize && plan.height === plan.canonicalSize) return transform;
  const values = transform.slice("matrix3d(".length, -1).split(",").map(Number);
  for (const index of [0, 1, 2]) values[index] *= plan.canonicalSize / plan.width;
  for (const index of [4, 5, 6]) values[index] *= plan.canonicalSize / plan.height;
  const factor = 10 ** Math.max(6, Math.min(12, plan.matrixDecimals));
  return `matrix3d(${values.map((value) => {
    const rounded = Math.round(value * factor) / factor;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }).join(",")})`;
}

export function triangleTransform(plan, sourcePositions, triangle) {
  invariant(Array.isArray(sourcePositions) && sourcePositions.length === 3, "INVALID_INTERACTION_PUBLICATION", "Prepared triangle publication needs three vertices.");
  const points = sourcePositions.map((position) => [position[2], position[0], position[1]]);
  const transform = computedTransform(points, plan, triangle, plan.basis);
  return transform === null ? null : fitTransform(transform, plan);
}
