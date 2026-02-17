/**
 * Stroke smoothing: convert a polyline to a smooth path using cubic Bezier curves
 * (Catmull-Rom spline converted to Bezier).
 *
 * Why this exists:
 * - Raw touch/stylus samples form a "polyline" (straight lines between points) which looks jagged.
 * - A Catmull–Rom spline naturally passes *through* your sample points (good for handwriting).
 * - Most renderers (including Skia) represent smooth curves as cubic Beziers,
 *   so we convert each Catmull–Rom segment into a cubic Bezier segment.
 */

export type Point = { x: number; y: number; pressure?: number };

// ---------------------------------------------------------------------------
// Path building
// ---------------------------------------------------------------------------

/**
 * Convert a sequence of points to an SVG path string using cubic Bezier segments
 * (Catmull-Rom to Bezier). Produces smooth curves through all points.
 *
 * For the first and last segment we clamp phantom control points by reusing endpoints,
 * avoiding extrapolation beyond the available samples.
 * The 1/6 factor comes from the standard Catmull–Rom → Bezier conversion.
 */
export function pointsToBezierPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  const n = points.length;
  let d = `M ${points[0].x} ${points[0].y}`;

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];

    // C1 = p1 + (p2 - p0) / 6
    // C2 = p2 - (p3 - p1) / 6
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

/**
 * Sample a cubic Bezier path at N steps and interpolate pressure.
 * Returns points suitable for pressure-sensitive circle rendering.
 *
 * stepsPerSegment controls fidelity: higher = smoother but more geometry.
 */
export function sampleSmoothedPath(
  points: Point[],
  stepsPerSegment: number = 4,
): Point[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [...points];
  if (points.length === 2) {
    const out: Point[] = [points[0]];
    for (let s = 1; s <= stepsPerSegment; s++) {
      const t = s / (stepsPerSegment + 1);
      out.push({
        x: points[0].x + t * (points[1].x - points[0].x),
        y: points[0].y + t * (points[1].y - points[0].y),
        pressure:
          (points[0].pressure ?? 0.5) +
          t * ((points[1].pressure ?? 0.5) - (points[0].pressure ?? 0.5)),
      });
    }
    out.push(points[1]);
    return out;
  }

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
      // Cubic Bezier point evaluation:
      // B(t) = (1-t)^3·p1 + 3(1-t)^2·t·c1 + 3(1-t)·t^2·c2 + t^3·p2
      const x =
        mt3 * p1.x + 3 * mt2 * t * c1x + 3 * mt * t2 * c2x + t3 * p2.x;
      const y =
        mt3 * p1.y + 3 * mt2 * t * c1y + 3 * mt * t2 * c2y + t3 * p2.y;
      const pressure =
        (p1.pressure ?? 0.5) +
        t * ((p2.pressure ?? 0.5) - (p1.pressure ?? 0.5));
      result.push({ x, y, pressure });
    }
  }
  result.push(points[n - 1]);
  return result;
}

// ---------------------------------------------------------------------------
// Eraser geometry
// ---------------------------------------------------------------------------

/** Squared distance between two points (avoids sqrt for fast hit testing). */
const r2 = (p: Point, q: Point) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;

/**
 * Interpolate points along the eraser path so fast swipes don't leave gaps.
 * Step size is proportional to the eraser radius so larger erasers are cheaper.
 */
export function densifyEraserPath(path: Point[], radius: number): Point[] {
  if (path.length <= 1) return path;
  const step = Math.max(2, radius * 0.4);
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + t * dx, y: a.y + t * dy });
    }
  }
  return out;
}

function isPointErased(p: Point, eraserPath: Point[], radius: number): boolean {
  const r2max = radius * radius;
  for (const ep of eraserPath) {
    if (r2(p, ep) <= r2max) return true;
  }
  return false;
}

function distToSegmentSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return r2(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return r2(p, proj);
}

function isSegmentTouchedByEraser(
  p1: Point,
  p2: Point,
  eraserPath: Point[],
  radius: number,
): boolean {
  const r2max = radius * radius;
  for (const ep of eraserPath) {
    if (distToSegmentSq(ep, p1, p2) <= r2max) return true;
  }
  return false;
}

/** Find t ∈ [0,1] where segment a→b first intersects a circle at `center` with radius `r`. */
function segmentCircleExitT(
  a: Point,
  b: Point,
  center: Point,
  r: number,
): number | null {
  const ux = a.x - center.x;
  const uy = a.y - center.y;
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const v2 = vx * vx + vy * vy;
  const uv = ux * vx + uy * vy;
  const u2 = ux * ux + uy * uy;
  const rr = r * r;
  const c = u2 - rr;
  const b2 = 2 * uv;
  if (v2 === 0) return null;
  const disc = b2 * b2 - 4 * v2 * c;
  if (disc < 0) return null;
  const sqrt = Math.sqrt(disc);
  const t1 = (-b2 - sqrt) / (2 * v2);
  const t2 = (-b2 + sqrt) / (2 * v2);
  const inRange: number[] = [];
  if (t1 >= 0 && t1 <= 1) inRange.push(t1);
  if (t2 >= 0 && t2 <= 1 && t2 !== t1) inRange.push(t2);
  if (inRange.length === 0) return null;
  return Math.min(...inRange);
}

/**
 * Split a stroke into sub-segments by removing parts the eraser touches.
 * A boundary point is inserted at each cut so stroke ends look clean.
 */
export function splitStrokeByEraser(
  points: Point[],
  eraserPath: Point[],
  radius: number,
): Point[][] {
  if (points.length === 0) return [];

  const dense = densifyEraserPath(eraserPath, radius);
  const kept = points.map(p => !isPointErased(p, dense, radius));

  const splitAfter: boolean[] = new Array(points.length).fill(false);
  const cutPointAfter: (Point | null)[] = new Array(points.length).fill(null);

  for (let i = 0; i < points.length - 1; i++) {
    if (isSegmentTouchedByEraser(points[i], points[i + 1], dense, radius)) {
      splitAfter[i] = true;
      let bestT: number | null = null;
      for (const ep of dense) {
        const t = segmentCircleExitT(points[i], points[i + 1], ep, radius);
        if (t != null && t > 1e-6 && (bestT == null || t < bestT)) bestT = t;
      }
      if (bestT != null) {
        cutPointAfter[i] = {
          x: points[i].x + bestT * (points[i + 1].x - points[i].x),
          y: points[i].y + bestT * (points[i + 1].y - points[i].y),
          pressure: points[i].pressure,
        };
      }
    }
  }

  const segments: Point[][] = [];
  let current: Point[] = [];

  for (let i = 0; i < points.length; i++) {
    if (kept[i]) {
      current.push(points[i]);
      if (splitAfter[i]) {
        const cut = cutPointAfter[i];
        if (cut) current.push(cut);
        if (current.length > 0) { segments.push(current); current = []; }
      }
    } else {
      if (current.length > 0) { segments.push(current); current = []; }
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
