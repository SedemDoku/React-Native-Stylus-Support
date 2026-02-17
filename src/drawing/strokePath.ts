/**
 * strokePath.ts
 *
 * GPU-accelerated stroke rendering via filled tapered polygons.
 *
 * Combines the native-Skia Path approach (one GPU draw call per stroke) with
 * algorithms ported from `perfect-freehand` by Steve Ruiz:
 *
 *  • STREAMLINE — Input smoothing via lerp between previous smoothed point
 *    and current raw point. Removes jitter without adding latency.
 *  • THINNING + EASING — Configurable pressure-to-radius mapping with a
 *    custom easing curve.
 *  • VELOCITY PRESSURE SIMULATION — When real pressure data is absent or
 *    unreliable, pressure is simulated from drawing speed.
 *  • START / END TAPERING — Gradual radius taper at stroke endpoints with
 *    configurable distance and easing.
 *  • SHARP CORNER HANDLING — Detects >90° turns and inserts rounded caps to
 *    prevent polygon self-intersection.
 *  • INITIAL PRESSURE SMOOTHING — Averages the first few points' pressure
 *    to prevent "fat starts" from slow stroke beginnings.
 *
 * OUTPUT: A single filled Skia Path — one GPU draw call per stroke.
 * All intermediate computations happen in JS; the path uses native cubicTo /
 * arcToOval commands that compile directly to GPU-ready draw data.
 */

import { Skia, SkPath } from '@shopify/react-native-skia';

export type Point = { x: number; y: number; pressure?: number };

// ---------------------------------------------------------------------------
// Options — mirrors perfect-freehand's StrokeOptions adapted for our system
// ---------------------------------------------------------------------------

export interface StrokePathOptions {
  /** Base size (diameter). Default 16. */
  size?: number;
  /**
   * How much pressure affects width. 0 = constant width, 1 = full variation.
   * Negative values invert (lighter pressure = thicker). Default 0.5.
   */
  thinning?: number;
  /**
   * Minimum distance between outline points (as fraction of size).
   * Higher = fewer polygon vertices = smoother edges. Default 0.5.
   */
  smoothing?: number;
  /**
   * Input smoothing. 0 = no smoothing (raw input), 1 = maximum smoothing.
   * Interpolates between previous smoothed point and raw input. Default 0.5.
   */
  streamline?: number;
  /** Easing function applied to pressure before radius calculation. */
  easing?: (t: number) => number;
  /** Whether to simulate pressure from velocity when real pressure is absent. Default false (use real stylus pressure). */
  simulatePressure?: boolean;
  /** Start of stroke: cap shape and taper. */
  start?: { cap?: boolean; taper?: number | boolean; easing?: (t: number) => number };
  /** End of stroke: cap shape and taper. */
  end?: { cap?: boolean; taper?: number | boolean; easing?: (t: number) => number };
  /** Whether this is a completed stroke (vs in-progress). Default false. */
  last?: boolean;
}

const DEFAULT_OPTIONS: Required<StrokePathOptions> = {
  size: 16,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
  easing: (t: number) => t,
  simulatePressure: false,
  start: { cap: true, taper: false, easing: (t: number) => t * (2 - t) },
  end: { cap: true, taper: false, easing: (t: number) => { t -= 1; return t * t * t + 1; } },
  last: false,
};

// ---------------------------------------------------------------------------
// Constants (ported from perfect-freehand)
// ---------------------------------------------------------------------------

const RATE_OF_PRESSURE_CHANGE = 0.275;
const FIXED_PI = Math.PI + 0.0001;
const MIN_RADIUS = 0.01;
const MIN_STREAMLINE_T = 0.15;
const STREAMLINE_T_RANGE = 0.85;
const END_NOISE_THRESHOLD = 3;
const CORNER_CAP_SEGMENTS = 13;

// ---------------------------------------------------------------------------
// Helper functions (ported from perfect-freehand)
// ---------------------------------------------------------------------------

function simulatePressure(
  prevPressure: number,
  distance: number,
  size: number,
): number {
  const sp = Math.min(1, distance / size);
  const rp = Math.min(1, 1 - sp);
  return Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
}

function getStrokeRadius(
  size: number,
  thinning: number,
  pressure: number,
  easing: (t: number) => number,
): number {
  return size * easing(0.5 - thinning * (0.5 - pressure));
}

function computeTaperDistance(
  taper: boolean | number | undefined,
  size: number,
  totalLength: number,
): number {
  if (taper === false || taper === undefined) return 0;
  if (taper === true) return Math.max(size, totalLength);
  return taper;
}

/** Dot product of 2D vectors. */
function dot(ax: number, ay: number, bx: number, by: number): number {
  return ax * bx + ay * by;
}

// ---------------------------------------------------------------------------
// Processed stroke point (intermediate representation)
// ---------------------------------------------------------------------------

interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  /** Unit vector from previous point to this point. */
  vx: number;
  vy: number;
  /** Distance from previous point. */
  distance: number;
  /** Cumulative running length. */
  runningLength: number;
  /** Computed radius at this point. */
  radius: number;
}

// ---------------------------------------------------------------------------
// Step 1: Process raw points into StrokePoints (streamline + pressure)
// ---------------------------------------------------------------------------

function processPoints(
  rawPoints: Point[],
  opts: Required<StrokePathOptions>,
): StrokePoint[] {
  if (rawPoints.length === 0) return [];

  const {
    size,
    thinning,
    streamline,
    easing,
    simulatePressure: shouldSimulatePressure,
    last: isComplete,
  } = opts;

  const t = MIN_STREAMLINE_T + (1 - streamline) * STREAMLINE_T_RANGE;

  // Streamline: interpolate raw input toward previous smoothed position.
  const smoothed: { x: number; y: number; pressure: number }[] = [];
  smoothed.push({
    x: rawPoints[0].x,
    y: rawPoints[0].y,
    pressure: rawPoints[0].pressure ?? 0.5,
  });

  for (let i = 1; i < rawPoints.length; i++) {
    const prev = smoothed[smoothed.length - 1];
    const raw = rawPoints[i];
    const isLast = i === rawPoints.length - 1;

    // For the final point of a completed stroke, use the exact position.
    const px = isComplete && isLast ? raw.x : prev.x + (raw.x - prev.x) * t;
    const py = isComplete && isLast ? raw.y : prev.y + (raw.y - prev.y) * t;

    // Skip if the smoothed point didn't actually move.
    const dx = px - prev.x;
    const dy = py - prev.y;
    if (dx * dx + dy * dy < 0.01) continue;

    smoothed.push({ x: px, y: py, pressure: raw.pressure ?? 0.5 });
  }

  if (smoothed.length === 1) {
    // Add a tiny offset so we have at least 2 points.
    smoothed.push({
      x: smoothed[0].x + 1,
      y: smoothed[0].y + 1,
      pressure: smoothed[0].pressure,
    });
  }

  // Build StrokePoint array with vectors, distances, running length, and radius.
  const result: StrokePoint[] = [];
  let runningLength = 0;
  let prevPressure = smoothed[0].pressure;

  // Initial pressure averaging (prevents fat starts).
  const initSlice = smoothed.slice(0, 10);
  prevPressure = initSlice.reduce((acc, pt, idx) => {
    let p = pt.pressure;
    if (shouldSimulatePressure && idx > 0) {
      const d = Math.hypot(
        pt.x - (idx > 0 ? smoothed[idx - 1].x : pt.x),
        pt.y - (idx > 0 ? smoothed[idx - 1].y : pt.y),
      );
      p = simulatePressure(acc, d, size);
    }
    return (acc + p) / 2;
  }, smoothed[0].pressure);

  for (let i = 0; i < smoothed.length; i++) {
    const pt = smoothed[i];
    let vx = 0, vy = 0, distance = 0;

    if (i > 0) {
      const prev = smoothed[i - 1];
      const dx = pt.x - prev.x;
      const dy = pt.y - prev.y;
      distance = Math.hypot(dx, dy);
      runningLength += distance;
      if (distance > 0) {
        vx = dx / distance;
        vy = dy / distance;
      }
    }

    let pressure = pt.pressure;
    if (shouldSimulatePressure) {
      pressure = simulatePressure(prevPressure, distance, size);
    }

    const radius = thinning
      ? Math.max(MIN_RADIUS, getStrokeRadius(size, thinning, pressure, easing))
      : size / 2;

    result.push({ x: pt.x, y: pt.y, pressure, vx, vy, distance, runningLength, radius });
    prevPressure = pressure;
  }

  // Set the first point's vector to match the second.
  if (result.length > 1) {
    result[0].vx = result[1].vx;
    result[0].vy = result[1].vy;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 2: Build outline (left/right rail points with tapering + corners)
// ---------------------------------------------------------------------------

interface OutlineArrays {
  leftX: number[];
  leftY: number[];
  rightX: number[];
  rightY: number[];
  /** Array of [index, radius] for points that need a sharp-corner cap. */
  cornerCaps: { x: number; y: number; vx: number; vy: number; radius: number }[];
}

function buildOutlineArrays(
  pts: StrokePoint[],
  opts: Required<StrokePathOptions>,
): OutlineArrays {
  const { size, smoothing, start, end, last: isComplete } = opts;
  const n = pts.length;
  const totalLength = pts[n - 1].runningLength;

  const taperStart = computeTaperDistance(start.taper, size, totalLength);
  const taperEnd = computeTaperDistance(end.taper, size, totalLength);
  const taperStartEase = start.easing ?? DEFAULT_OPTIONS.start.easing!;
  const taperEndEase = end.easing ?? DEFAULT_OPTIONS.end.easing!;

  const minDist2 = Math.pow(size * smoothing, 2);

  const leftX: number[] = [];
  const leftY: number[] = [];
  const rightX: number[] = [];
  const rightY: number[] = [];
  const cornerCaps: OutlineArrays['cornerCaps'] = [];

  let isPrevSharpCorner = false;

  for (let i = 0; i < n; i++) {
    const pt = pts[i];
    const isLast = i === n - 1;

    // End noise filtering.
    if (!isLast && totalLength - pt.runningLength < END_NOISE_THRESHOLD) continue;

    // Apply tapering.
    let radius = pt.radius;
    const taperStartStr = pt.runningLength < taperStart
      ? taperStartEase(pt.runningLength / taperStart)
      : 1;
    const taperEndStr = totalLength - pt.runningLength < taperEnd
      ? taperEndEase((totalLength - pt.runningLength) / taperEnd)
      : 1;
    radius = Math.max(MIN_RADIUS, radius * Math.min(taperStartStr, taperEndStr));

    // Sharp corner detection.
    const nextVx = isLast ? pt.vx : pts[i + 1].vx;
    const nextVy = isLast ? pt.vy : pts[i + 1].vy;
    const nextDot = isLast ? 1 : dot(pt.vx, pt.vy, nextVx, nextVy);
    const prevDot = i > 0 ? dot(pt.vx, pt.vy, pts[i - 1].vx, pts[i - 1].vy) : 1;

    const isSharpCorner = prevDot < 0 && !isPrevSharpCorner;
    const isNextSharp = nextDot < 0;

    if (isSharpCorner || isNextSharp) {
      cornerCaps.push({ x: pt.x, y: pt.y, vx: pt.vx, vy: pt.vy, radius });

      // Add semicircular cap points at the corner.
      const perpVx = pt.vy;
      const perpVy = -pt.vx;
      const step = 1 / CORNER_CAP_SEGMENTS;
      for (let t = 0; t <= 1; t += step) {
        const angle = FIXED_PI * t;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const ox = perpVx * radius;
        const oy = perpVy * radius;
        // Left: rotate (point - offset) around point.
        const lrx = -ox * cosA - (-oy) * sinA;
        const lry = -ox * sinA + (-oy) * cosA;
        leftX.push(pt.x + lrx);
        leftY.push(pt.y + lry);
        // Right: rotate (point + offset) around point.
        const rrx = ox * cosA - oy * sinA;
        const rry = ox * sinA + oy * cosA;
        rightX.push(pt.x + rrx);
        rightY.push(pt.y + rry);
      }

      if (isNextSharp) isPrevSharpCorner = true;
      continue;
    }

    isPrevSharpCorner = false;

    // Perpendicular offset direction — blend current and next vectors.
    let ox: number, oy: number;
    if (isLast) {
      ox = pt.vy;
      oy = -pt.vx;
    } else {
      // Interpolate between current and next vector for smoother offset direction.
      const blendX = nextVx + pt.vx;
      const blendY = nextVy + pt.vy;
      const blendLen = Math.hypot(blendX, blendY);
      if (blendLen < 1e-6) {
        ox = pt.vy;
        oy = -pt.vx;
      } else {
        // Perpendicular of the blended direction.
        ox = blendY / blendLen;
        oy = -blendX / blendLen;
      }
    }

    const lx = pt.x - ox * radius;
    const ly = pt.y - oy * radius;
    const rx = pt.x + ox * radius;
    const ry = pt.y + oy * radius;

    // Min-distance filtering for outline smoothing.
    if (i <= 1 || leftX.length === 0 || squaredDist(leftX[leftX.length - 1], leftY[leftY.length - 1], lx, ly) > minDist2) {
      leftX.push(lx);
      leftY.push(ly);
    }
    if (i <= 1 || rightX.length === 0 || squaredDist(rightX[rightX.length - 1], rightY[rightY.length - 1], rx, ry) > minDist2) {
      rightX.push(rx);
      rightY.push(ry);
    }
  }

  return { leftX, leftY, rightX, rightY, cornerCaps };
}

function squaredDist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------
// Step 3: Assemble outline points into a Skia Path
// ---------------------------------------------------------------------------

function assembleSkiaPath(
  pts: StrokePoint[],
  outline: OutlineArrays,
  opts: Required<StrokePathOptions>,
): SkPath {
  const path = Skia.Path.Make();
  const { leftX: lx, leftY: ly, rightX: rx, rightY: ry } = outline;
  const { start, end } = opts;

  const nL = lx.length;
  const nR = rx.length;

  if (nL === 0 || nR === 0) return path;

  const totalLength = pts[pts.length - 1].runningLength;
  const taperStart = computeTaperDistance(start.taper, opts.size, totalLength);
  const taperEnd = computeTaperDistance(end.taper, opts.size, totalLength);
  const capStart = start.cap !== false;
  const capEnd = end.cap !== false;

  // Very short stroke → dot.
  if (pts.length === 1 || (nL < 2 && nR < 2)) {
    const r = pts[0].radius;
    path.addCircle(pts[0].x, pts[0].y, Math.max(0.5, r));
    return path;
  }

  // ---- Start cap ----
  path.moveTo(rx[0], ry[0]);

  if (taperStart > 0) {
    // Tapered start: just begin at right[0], no cap needed.
  } else if (capStart) {
    // Round start cap: semicircle from right[0] around center to left[0].
    const cx = (rx[0] + lx[0]) / 2;
    const cy = (ry[0] + ly[0]) / 2;
    const r = Math.hypot(rx[0] - lx[0], ry[0] - ly[0]) / 2;
    if (r > 0.1) {
      const startAngle = Math.atan2(ry[0] - cy, rx[0] - cx) * (180 / Math.PI);
      path.arcToOval(
        { x: cx - r, y: cy - r, width: r * 2, height: r * 2 },
        startAngle,
        180,
        false,
      );
    }
  } else {
    // Flat start cap: just lineTo left[0].
    path.lineTo(lx[0], ly[0]);
  }

  // ---- Left rail (forward) — Catmull-Rom → Bezier cubics ----
  if (nL > 1) {
    // Ensure we start at left[0].
    if (taperStart > 0 || !capStart) {
      // We haven't arrived at left[0] via the cap, so moveTo/lineTo.
    }
    for (let i = 0; i < nL - 1; i++) {
      const i0 = Math.max(0, i - 1);
      const i3 = Math.min(nL - 1, i + 2);
      path.cubicTo(
        lx[i] + (lx[i + 1] - lx[i0]) / 6,
        ly[i] + (ly[i + 1] - ly[i0]) / 6,
        lx[i + 1] - (lx[i3] - lx[i]) / 6,
        ly[i + 1] - (ly[i3] - ly[i]) / 6,
        lx[i + 1],
        ly[i + 1],
      );
    }
  }

  // ---- End cap ----
  if (taperEnd > 0) {
    // Tapered end: connect to last right point directly.
    path.lineTo(rx[nR - 1], ry[nR - 1]);
  } else if (capEnd) {
    // Round end cap: semicircle from left[last] around center to right[last].
    const cx = (lx[nL - 1] + rx[nR - 1]) / 2;
    const cy = (ly[nL - 1] + ry[nR - 1]) / 2;
    const r = Math.hypot(lx[nL - 1] - rx[nR - 1], ly[nL - 1] - ry[nR - 1]) / 2;
    if (r > 0.1) {
      const endAngle = Math.atan2(ly[nL - 1] - cy, lx[nL - 1] - cx) * (180 / Math.PI);
      path.arcToOval(
        { x: cx - r, y: cy - r, width: r * 2, height: r * 2 },
        endAngle,
        180,
        false,
      );
    }
  } else {
    // Flat end cap.
    path.lineTo(rx[nR - 1], ry[nR - 1]);
  }

  // ---- Right rail (backward) — Catmull-Rom → Bezier cubics ----
  if (nR > 1) {
    for (let i = nR - 1; i > 0; i--) {
      const i0 = Math.min(nR - 1, i + 1);
      const i3 = Math.max(0, i - 2);
      path.cubicTo(
        rx[i] + (rx[i - 1] - rx[i0]) / 6,
        ry[i] + (ry[i - 1] - ry[i0]) / 6,
        rx[i - 1] - (rx[i3] - rx[i]) / 6,
        ry[i - 1] - (ry[i3] - ry[i]) / 6,
        rx[i - 1],
        ry[i - 1],
      );
    }
  }

  path.close();
  return path;
}

// ---------------------------------------------------------------------------
// Public API: buildStrokePath (replaces buildRibbonPath)
// ---------------------------------------------------------------------------

/**
 * Build a filled Skia Path for a pressure-sensitive stroke.
 *
 * Combines the ribbon approach with perfect-freehand's streamline smoothing,
 * velocity pressure simulation, tapering, and sharp corner handling.
 *
 * @param points    Raw input points from the stylus.
 * @param options   Stroke rendering options.
 */
export function buildStrokePath(
  points: Point[],
  options: Partial<StrokePathOptions> = {},
): SkPath {
  const opts = { ...DEFAULT_OPTIONS, ...options } as Required<StrokePathOptions>;
  opts.start = { ...DEFAULT_OPTIONS.start, ...options.start };
  opts.end = { ...DEFAULT_OPTIONS.end, ...options.end };

  if (points.length === 0) return Skia.Path.Make();

  const strokePoints = processPoints(points, opts);
  if (strokePoints.length === 0) return Skia.Path.Make();

  const outline = buildOutlineArrays(strokePoints, opts);
  return assembleSkiaPath(strokePoints, outline, opts);
}

// ---------------------------------------------------------------------------
// Legacy API: buildRibbonPath (backward compat for committed strokes)
// ---------------------------------------------------------------------------

/**
 * Build a filled Skia Path using the old minRadius/maxRadius API.
 * Converts to the new options format internally.
 */
export function buildRibbonPath(
  points: Point[],
  minRadius: number,
  maxRadius: number,
): SkPath {
  // Map old min/max radius to perfect-freehand size/thinning model.
  // size = diameter = 2 * maxRadius
  // At pressure 0.5 (default), radius should be (min+max)/2.
  // At pressure 1.0, radius should be maxRadius.
  // At pressure 0.0, radius should be minRadius.
  const size = maxRadius * 2;
  const thinning = maxRadius > 0 ? 1 - (minRadius / maxRadius) : 0.5;

  return buildStrokePath(points, {
    size,
    thinning,
    smoothing: 0.3,
    streamline: 0.4,
    simulatePressure: false,
    start: { cap: true, taper: false },
    end: { cap: true, taper: false },
    last: true,
  });
}

// ---------------------------------------------------------------------------
// Catmull-Rom sampler (legacy, kept for eraser and other consumers)
// ---------------------------------------------------------------------------

export function sampleCenterline(
  points: Point[],
  stepsPerSegment: number,
): Point[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0]];

  const n = points.length;
  const result: Point[] = [points[0]];

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];

    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;

    for (let s = 1; s <= stepsPerSegment; s++) {
      const t = s / (stepsPerSegment + 1);
      const mt = 1 - t;
      const mt2 = mt * mt;
      const mt3 = mt2 * mt;
      const t2 = t * t;
      const t3 = t2 * t;
      result.push({
        x: mt3 * p1.x + 3 * mt2 * t * c1x + 3 * mt * t2 * c2x + t3 * p2.x,
        y: mt3 * p1.y + 3 * mt2 * t * c1y + 3 * mt * t2 * c2y + t3 * p2.y,
        pressure: (p1.pressure ?? 0.5) + t * ((p2.pressure ?? 0.5) - (p1.pressure ?? 0.5)),
      });
    }
  }
  result.push(points[n - 1]);
  return result;
}

// ---------------------------------------------------------------------------
// IncrementalRibbon — live stroke builder with perfect-freehand processing
// ---------------------------------------------------------------------------

/**
 * IncrementalRibbon builds a stroke path incrementally for live drawing.
 *
 * Uses the full perfect-freehand processing pipeline (streamline, pressure
 * simulation, tapering, sharp corners) but with cached computations and
 * Skia-native path output.
 *
 * The path is rebuilt from cached smoothed points on each `getPath()` call.
 * Streamline smoothing is applied incrementally as points arrive.
 */
export class IncrementalRibbon {
  private minRadius: number;
  private maxRadius: number;
  private rawPoints: Point[] = [];

  /** Streamline-smoothed points, updated incrementally in addPoint(). */
  private smoothedPoints: Point[] = [];

  /** Options derived from minRadius/maxRadius on construction. */
  private opts: Required<StrokePathOptions>;

  constructor(minRadius: number, maxRadius: number) {
    this.minRadius = minRadius;
    this.maxRadius = maxRadius;

    const size = maxRadius * 2;
    const thinning = maxRadius > 0 ? 1 - (minRadius / maxRadius) : 0.5;

    this.opts = {
      ...DEFAULT_OPTIONS,
      size,
      thinning,
      smoothing: 0.3,
      streamline: 0.4,
      simulatePressure: false,
      start: { cap: true, taper: false, easing: DEFAULT_OPTIONS.start.easing },
      end: { cap: true, taper: false, easing: DEFAULT_OPTIONS.end.easing },
      last: false,
    };
  }

  addPoint(x: number, y: number, pressure: number): void {
    this.rawPoints.push({ x, y, pressure });

    // Incrementally apply streamline smoothing.
    const t = MIN_STREAMLINE_T + (1 - this.opts.streamline) * STREAMLINE_T_RANGE;

    if (this.smoothedPoints.length === 0) {
      this.smoothedPoints.push({ x, y, pressure });
    } else {
      const prev = this.smoothedPoints[this.smoothedPoints.length - 1];
      const sx = prev.x + (x - prev.x) * t;
      const sy = prev.y + (y - prev.y) * t;
      const dx = sx - prev.x;
      const dy = sy - prev.y;
      if (dx * dx + dy * dy >= 0.01) {
        this.smoothedPoints.push({ x: sx, y: sy, pressure });
      }
    }
  }

  /**
   * Build the stroke path from current smoothed points.
   * Marked volatile for Skia GPU hint (skip caching in-progress paths).
   */
  getPath(): SkPath {
    if (this.smoothedPoints.length === 0) return Skia.Path.Make();

    const strokePoints = processPoints(this.smoothedPoints, this.opts);
    if (strokePoints.length === 0) return Skia.Path.Make();

    const outline = buildOutlineArrays(strokePoints, this.opts);
    const path = assembleSkiaPath(strokePoints, outline, this.opts);
    path.setIsVolatile(true);
    return path;
  }

  get pointCount(): number {
    return this.rawPoints.length;
  }

  getPoints(): Point[] {
    return this.rawPoints;
  }

  reset(): void {
    this.rawPoints = [];
    this.smoothedPoints = [];
  }

  updateSettings(minRadius: number, maxRadius: number): void {
    this.minRadius = minRadius;
    this.maxRadius = maxRadius;
    const size = maxRadius * 2;
    const thinning = maxRadius > 0 ? 1 - (minRadius / maxRadius) : 0.5;
    this.opts.size = size;
    this.opts.thinning = thinning;
  }
}
