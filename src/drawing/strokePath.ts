/**
 * strokePath.ts
 *
 * GPU-accelerated stroke rendering via filled tapered polygons.
 *
 * WHY NOT CIRCLES?
 * ----------------
 * The previous approach drew one <Circle> Skia element per smoothed sample point.
 * With stepsPerSegment=3 and a 200-point stroke, that's ~600 individual draw calls
 * per stroke, all dispatched from the JS thread and diffed by React on every frame.
 *
 * A tapered polygon ("ribbon") encodes the entire stroke as a single filled Path.
 * The GPU renders it in one draw call regardless of stroke length.
 * CPU work drops from O(samples × stepsPerSegment) to O(controlPoints) per frame.
 *
 * HOW IT WORKS
 * ------------
 * For each raw control point we compute a perpendicular offset scaled by the
 * pressure-derived radius, producing left/right "rail" points. Rails are
 * connected with Catmull-Rom → Bezier cubicTo() calls — O(n) path verbs
 * instead of O(n × steps) lineTo segments — producing smoother curves with
 * ~4× fewer JSI bridge crossings. Round caps join the rails at start and end.
 * The result is a single filled Path — one GPU draw call.
 *
 * VOLATILE PATHS (Skia GPU hint)
 * ------------------------------
 * Active (in-progress) stroke paths are marked setIsVolatile(true). This tells
 * Skia's GPU backend to skip caching intermediate rasterisation data for the
 * path, avoiding wasted cache-invalidation on paths that change every frame.
 *
 * SKIA PATH (not SVG string)
 * --------------------------
 * We use `Skia.Path.Make()` directly instead of building an SVG string.
 * Skia paths are compiled to GPU-ready draw commands immediately; SVG strings
 * need to be parsed back into paths first. For paths that update every frame
 * (the active stroke) this saves significant CPU time.
 */

import { Skia, SkPath } from '@shopify/react-native-skia';

export type Point = { x: number; y: number; pressure?: number };

// ---------------------------------------------------------------------------
// Catmull-Rom → Bezier smoothing (kept in this file for locality)
// ---------------------------------------------------------------------------

/**
 * Sample a Catmull-Rom spline through `points` at `stepsPerSegment` interior
 * points per segment. Returns an array of (x, y, pressure) ready for ribbon building.
 *
 * Kept here (duplicating smoothing.ts) so strokePath.ts is self-contained and
 * tree-shakeable independently.
 */
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
// Ribbon (tapered polygon) builder
// ---------------------------------------------------------------------------

/**
 * Build a filled Skia Path that represents a variable-width stroke.
 *
 * Algorithm:
 *  1. For each raw control point, compute the pressure-derived radius and the
 *     perpendicular offset from the tangent direction.
 *  2. Build left/right "rail" points offset from the centerline.
 *  3. Connect rails with Catmull-Rom → Bezier cubicTo() calls, producing a
 *     smooth closed polygon with round caps at start and end.
 *
 * This eliminates the previous sampleCenterline() oversampling step entirely.
 * Path verb count drops from O(n × steps) lineTo to O(n) cubicTo — ~4× fewer
 * JSI bridge crossings while producing smoother GPU-native Bezier curves.
 *
 * @param points    Raw control points from the stylus.
 * @param minRadius Radius at zero pressure.
 * @param maxRadius Radius at full pressure.
 */
export function buildRibbonPath(
  points: Point[],
  minRadius: number,
  maxRadius: number,
): SkPath {
  const path = Skia.Path.Make();

  if (points.length === 0) return path;

  // Single point → filled circle
  if (points.length === 1) {
    const r = minRadius + (maxRadius - minRadius) * (points[0].pressure ?? 0.5);
    path.addCircle(points[0].x, points[0].y, Math.max(0.5, r));
    return path;
  }

  const n = points.length;

  // Pre-compute radii and perpendicular unit vectors for each control point.
  const radii = new Float32Array(n);
  const perpX = new Float32Array(n);
  const perpY = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    radii[i] = Math.max(
      0.5,
      minRadius + (maxRadius - minRadius) * (points[i].pressure ?? 0.5),
    );

    // Tangent: forward diff at start, backward at end, central elsewhere.
    let tx: number, ty: number;
    if (i === 0) {
      tx = points[1].x - points[0].x;
      ty = points[1].y - points[0].y;
    } else if (i === n - 1) {
      tx = points[n - 1].x - points[n - 2].x;
      ty = points[n - 1].y - points[n - 2].y;
    } else {
      tx = points[i + 1].x - points[i - 1].x;
      ty = points[i + 1].y - points[i - 1].y;
    }

    const len = Math.hypot(tx, ty);
    if (len < 1e-6) {
      perpX[i] = i > 0 ? perpX[i - 1] : 0;
      perpY[i] = i > 0 ? perpY[i - 1] : 1;
    } else {
      perpX[i] = -ty / len;
      perpY[i] = tx / len;
    }
  }

  // Left and right rail arrays.
  const leftX = new Float32Array(n);
  const leftY = new Float32Array(n);
  const rightX = new Float32Array(n);
  const rightY = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const cx = points[i].x;
    const cy = points[i].y;
    const r = radii[i];
    leftX[i] = cx + perpX[i] * r;
    leftY[i] = cy + perpY[i] * r;
    rightX[i] = cx - perpX[i] * r;
    rightY[i] = cy - perpY[i] * r;
  }

  // -------------------------------------------------------------------------
  // Assemble the closed ribbon polygon
  // -------------------------------------------------------------------------

  // Start cap: semicircle from right[0] → left[0].
  const startR = radii[0];
  const startAngle = Math.atan2(perpY[0], perpX[0]) * (180 / Math.PI);

  path.moveTo(rightX[0], rightY[0]);
  path.arcToOval(
    { x: points[0].x - startR, y: points[0].y - startR, width: startR * 2, height: startR * 2 },
    startAngle + 90,
    180,
    false,
  );

  // Forward along the left rail — Catmull-Rom → Bezier cubics.
  for (let i = 0; i < n - 1; i++) {
    const i0 = Math.max(0, i - 1);
    const i3 = Math.min(n - 1, i + 2);
    path.cubicTo(
      leftX[i] + (leftX[i + 1] - leftX[i0]) / 6,
      leftY[i] + (leftY[i + 1] - leftY[i0]) / 6,
      leftX[i + 1] - (leftX[i3] - leftX[i]) / 6,
      leftY[i + 1] - (leftY[i3] - leftY[i]) / 6,
      leftX[i + 1],
      leftY[i + 1],
    );
  }

  // End cap: semicircle from left[n-1] → right[n-1].
  const endR = radii[n - 1];
  const endAngle = Math.atan2(perpY[n - 1], perpX[n - 1]) * (180 / Math.PI);

  path.arcToOval(
    { x: points[n - 1].x - endR, y: points[n - 1].y - endR, width: endR * 2, height: endR * 2 },
    endAngle - 90,
    180,
    false,
  );

  // Backward along the right rail — Catmull-Rom → Bezier cubics (reversed).
  for (let i = n - 1; i > 0; i--) {
    const i0 = Math.min(n - 1, i + 1);
    const i3 = Math.max(0, i - 2);
    path.cubicTo(
      rightX[i] + (rightX[i - 1] - rightX[i0]) / 6,
      rightY[i] + (rightY[i - 1] - rightY[i0]) / 6,
      rightX[i - 1] - (rightX[i3] - rightX[i]) / 6,
      rightY[i - 1] - (rightY[i3] - rightY[i]) / 6,
      rightX[i - 1],
      rightY[i - 1],
    );
  }

  path.close();
  return path;
}

// ---------------------------------------------------------------------------
// Incremental path builder for the active (in-progress) stroke
// ---------------------------------------------------------------------------

/**
 * IncrementalRibbon builds the ribbon path with cached per-point data.
 *
 * PERFORMANCE MODEL
 * -----------------
 * Per-point math (radii, perpendiculars, rail offsets) is computed ONCE when
 * the point is added and cached in typed arrays. When a new point arrives only
 * the new point and the previous point (whose tangent depends on the new next
 * neighbour) are (re)computed — O(1) math per event.
 *
 * `getPath()` assembles the SkPath from pre-computed rail arrays. The work is
 * O(n) cubicTo JSI calls (unavoidable — Skia needs the full contour) but with
 * ZERO per-point math and ZERO typed-array allocation. For n = 300, the
 * cubicTo assembly takes ~1 ms on mid-range hardware; the math savings avoid
 * another ~0.5 ms of repeated work that was previously done every frame.
 *
 * Usage:
 *   const ribbon = new IncrementalRibbon(minR, maxR);
 *   ribbon.addPoint(x, y, pressure);   // call for each stylus sample
 *   const path = ribbon.getPath();     // call once per render
 *   ribbon.reset();                    // call on pen-up
 */
export class IncrementalRibbon {
  private minRadius: number;
  private maxRadius: number;
  private points: Point[] = [];

  // Cached per-point computations — grown dynamically, never reallocated.
  private _radii: number[] = [];
  private _perpX: number[] = [];
  private _perpY: number[] = [];
  private _leftX: number[] = [];
  private _leftY: number[] = [];
  private _rightX: number[] = [];
  private _rightY: number[] = [];

  /** Index up to which the cache is valid (inclusive). -1 = nothing cached. */
  private _cacheValid = -1;

  constructor(minRadius: number, maxRadius: number) {
    this.minRadius = minRadius;
    this.maxRadius = maxRadius;
  }

  addPoint(x: number, y: number, pressure: number): void {
    this.points.push({ x, y, pressure });

    // The previous point's tangent used a forward-diff or central-diff that
    // depended on the "next" point. Now that there IS a next point, the
    // previous entry must be recomputed. Invalidate from (len - 2).
    const len = this.points.length;
    if (this._cacheValid >= len - 2) {
      this._cacheValid = Math.max(-1, len - 3);
    }
  }

  // -----------------------------------------------------------------------
  // Internal: update cached arrays for any new / invalidated indices.
  // -----------------------------------------------------------------------

  private _updateCache(): void {
    const pts = this.points;
    const n = pts.length;
    if (n === 0) return;

    const start = this._cacheValid + 1;

    // Grow arrays if needed (cheap — push is amortised O(1)).
    while (this._radii.length < n) {
      this._radii.push(0);
      this._perpX.push(0);
      this._perpY.push(0);
      this._leftX.push(0);
      this._leftY.push(0);
      this._rightX.push(0);
      this._rightY.push(0);
    }

    for (let i = start; i < n; i++) {
      // Pressure-derived radius.
      const r = Math.max(
        0.5,
        this.minRadius +
          (this.maxRadius - this.minRadius) * (pts[i].pressure ?? 0.5),
      );
      this._radii[i] = r;

      // Tangent direction (forward / central / backward difference).
      let tx: number, ty: number;
      if (n === 1) {
        // Single point — no neighbour to diff against; use zero tangent.
        tx = 0;
        ty = 0;
      } else if (i === 0) {
        tx = pts[1].x - pts[0].x;
        ty = pts[1].y - pts[0].y;
      } else if (i === n - 1) {
        tx = pts[n - 1].x - pts[n - 2].x;
        ty = pts[n - 1].y - pts[n - 2].y;
      } else {
        tx = pts[i + 1].x - pts[i - 1].x;
        ty = pts[i + 1].y - pts[i - 1].y;
      }

      const len = Math.hypot(tx, ty);
      if (len < 1e-6) {
        this._perpX[i] = i > 0 ? this._perpX[i - 1] : 0;
        this._perpY[i] = i > 0 ? this._perpY[i - 1] : 1;
      } else {
        this._perpX[i] = -ty / len;
        this._perpY[i] = tx / len;
      }

      // Left / right rail offsets.
      const cx = pts[i].x;
      const cy = pts[i].y;
      this._leftX[i] = cx + this._perpX[i] * r;
      this._leftY[i] = cy + this._perpY[i] * r;
      this._rightX[i] = cx - this._perpX[i] * r;
      this._rightY[i] = cy - this._perpY[i] * r;
    }

    this._cacheValid = n - 1;
  }

  /**
   * Assemble the full ribbon SkPath from cached rail data.
   *
   * The math (radii, perpendiculars, rails) is already done — this method
   * only issues Skia path-building commands using pre-computed numbers.
   * Marked volatile so Skia skips GPU-side caching for in-progress paths.
   */
  getPath(): SkPath {
    this._updateCache();

    const path = Skia.Path.Make();
    const n = this.points.length;

    if (n === 0) return path;

    if (n === 1) {
      const r = this._radii[0];
      path.addCircle(this.points[0].x, this.points[0].y, Math.max(0.5, r));
      path.setIsVolatile(true);
      return path;
    }

    const {
      _radii: radii,
      _perpX: perpX,
      _perpY: perpY,
      _leftX: lx,
      _leftY: ly,
      _rightX: rx,
      _rightY: ry,
      points: pts,
    } = this;

    // Start cap: semicircle right[0] → left[0].
    const startR = radii[0];
    const startAng = Math.atan2(perpY[0], perpX[0]) * (180 / Math.PI);
    path.moveTo(rx[0], ry[0]);
    path.arcToOval(
      {
        x: pts[0].x - startR,
        y: pts[0].y - startR,
        width: startR * 2,
        height: startR * 2,
      },
      startAng + 90,
      180,
      false,
    );

    // Left rail forward — Catmull-Rom → Bezier cubics.
    for (let i = 0; i < n - 1; i++) {
      const i0 = Math.max(0, i - 1);
      const i3 = Math.min(n - 1, i + 2);
      path.cubicTo(
        lx[i] + (lx[i + 1] - lx[i0]) / 6,
        ly[i] + (ly[i + 1] - ly[i0]) / 6,
        lx[i + 1] - (lx[i3] - lx[i]) / 6,
        ly[i + 1] - (ly[i3] - ly[i]) / 6,
        lx[i + 1],
        ly[i + 1],
      );
    }

    // End cap: semicircle left[n-1] → right[n-1].
    const endR = radii[n - 1];
    const endAng = Math.atan2(perpY[n - 1], perpX[n - 1]) * (180 / Math.PI);
    path.arcToOval(
      {
        x: pts[n - 1].x - endR,
        y: pts[n - 1].y - endR,
        width: endR * 2,
        height: endR * 2,
      },
      endAng - 90,
      180,
      false,
    );

    // Right rail backward — Catmull-Rom → Bezier cubics (reversed).
    for (let i = n - 1; i > 0; i--) {
      const i0 = Math.min(n - 1, i + 1);
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

    path.close();
    path.setIsVolatile(true);
    return path;
  }

  get pointCount(): number {
    return this.points.length;
  }

  getPoints(): Point[] {
    return this.points;
  }

  reset(): void {
    this.points = [];
    this._radii.length = 0;
    this._perpX.length = 0;
    this._perpY.length = 0;
    this._leftX.length = 0;
    this._leftY.length = 0;
    this._rightX.length = 0;
    this._rightY.length = 0;
    this._cacheValid = -1;
  }

  updateSettings(minRadius: number, maxRadius: number): void {
    this.minRadius = minRadius;
    this.maxRadius = maxRadius;
  }
}
