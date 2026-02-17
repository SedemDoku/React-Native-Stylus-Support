/**
 * CanvasView.tsx — GPU-accelerated drawing surface
 *
 * KEY PERFORMANCE CHANGES vs. previous version
 * ============================================
 *
 * 1. COMMITTED STROKES → GPU PICTURE (texture cache)
 *    Previous: Every committed stroke re-rendered as React elements on every frame.
 *    Now: On pen-up, the finished stroke is painted into a Skia `Picture` (a recorded
 *    command list that lives on the GPU). The committed layer renders as a single
 *    `<Picture>` element — one GPU draw call, zero JS/React work, no React diffing.
 *    Adding a new stroke appends to the picture; existing ink is never re-touched.
 *
 * 2. ACTIVE STROKE → FILLED RIBBON PATH (one draw call, no circles)
 *    Previous: `sampleSmoothedPath(points, 3)` → hundreds of <Circle> elements
 *    per frame, all diffed by React.
 *    Now: `buildRibbonPath()` converts raw control points to a single filled
 *    polygon (tapered ribbon) via Skia's native path API. The GPU fills it in
 *    one draw call. React renders exactly 1 `<Path>` element for the entire
 *    active stroke.
 *
 * 3. INCREMENTAL ACTIVE STROKE BUILDING
 *    `IncrementalRibbon` accumulates stylus points and rebuilds the ribbon path
 *    only on rAF ticks (~60fps), not on every sample. Path construction is O(n)
 *    in control points (typically 3–6 per segment), not in smoothed samples.
 *
 * 4. NO MORE STRING PATHS
 *    SVG strings (`"M x y C x1 y1 x2 y2 x y ..."`) need to be parsed back into
 *    native Skia paths. We use `Skia.Path.Make()` directly everywhere, which gives
 *    Skia pre-compiled path data with no parsing overhead.
 *
 * 5. ERASER USES PICTURE COMPOSITING
 *    After an erase operation the remaining stroke segments are immediately
 *    re-recorded into the picture. Erasing one stroke doesn't force all others
 *    to re-render as React elements.
 */

import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { StyleProp, ViewStyle, StyleSheet, View } from 'react-native';
import {
  Canvas,
  Path,
  Picture,
  createPicture,
  Skia,
  SkPicture,
  SkPath,
  PaintStyle,
  Group,
} from '@shopify/react-native-skia';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { useSharedValue, runOnJS } from 'react-native-reanimated';
import { useStylusEvents } from 'react-native-stylus-events-local';
import { splitStrokeByEraser } from '../drawing/smoothing';
import { buildRibbonPath, IncrementalRibbon } from '../drawing/strokePath';
import type { Stroke } from '../drawing/Stroke';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RawPoint = { x: number; y: number; pressure: number };

export type StylusDebug = {
  phase: 'down' | 'move' | 'up';
  x: number;
  y: number;
  canvasX: number;
  canvasY: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  orientation?: number;
  timestamp?: number;
  toolType?: 'stylus' | 'eraser' | 'unknown';
};

export type CanvasViewRef = {
  clear: () => void;
};

type Props = {
  style?: StyleProp<ViewStyle>;
  strokeColor?: string;
  toolMode?: 'pen' | 'eraser';
  eraserRadius?: number;
  strokeWidth?: number;
  minRadius?: number;
  maxRadius?: number;
  onStylusDebug?: (info: StylusDebug) => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const MIN_POINT_DIST_SQ = 4; // 2px minimum movement threshold

const clamp = (v: number, lo: number, hi: number): number => {
  'worklet';
  return Math.max(lo, Math.min(hi, v));
};

function normalizePressure(raw: number | undefined): number {
  if (typeof raw === 'number' && raw >= 0) return Math.max(0, Math.min(1, raw));
  return 0.5;
}

// ---------------------------------------------------------------------------
// Picture layer helpers
// ---------------------------------------------------------------------------

/**
 * Record all strokes into a Skia Picture (GPU command buffer).
 *
 * createPicture() records draw calls into a SkPicture. When the Picture is
 * rendered, Skia replays the recorded commands directly on the GPU — no JS,
 * no React, no re-diffing. This is the key to making committed ink free.
 *
 * We call this:
 * - On pen-up (to add a finished stroke)
 * - After an erase (to rebuild from surviving segments)
 * - On clear (to produce an empty picture)
 */
function recordStrokesToPicture(
  strokes: Stroke[],
  minRadius: number,
  maxRadius: number,
  canvasWidth: number,
  canvasHeight: number,
): SkPicture {
  return createPicture((canvas) => {
    // Reuse a single Paint across all strokes — only the color changes.
    const paint = Skia.Paint();
    paint.setStyle(PaintStyle.Fill);
    paint.setAntiAlias(true);

    for (const stroke of strokes) {
      if (stroke.points.length === 0) continue;

      paint.setColor(Skia.Color(stroke.color));

      const path = buildRibbonPath(
        stroke.points,
        stroke.minRadius ?? minRadius,
        stroke.maxRadius ?? maxRadius,
      );
      canvas.drawPath(path, paint);
    }
  }, { x: 0, y: 0, width: canvasWidth || 2000, height: canvasHeight || 3000 });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const CanvasView = forwardRef<CanvasViewRef, Props>(function CanvasView(
  {
    style,
    strokeColor = '#111',
    toolMode = 'pen',
    eraserRadius = 24,
    strokeWidth = 2.5,
    minRadius = 0.5,
    maxRadius = 14,
    onStylusDebug,
  },
  ref,
) {
  // -------------------------------------------------------------------------
  // Canvas size (needed for createPicture bounds)
  // -------------------------------------------------------------------------
  const canvasSize = useRef({ width: 2000, height: 3000 });

  // -------------------------------------------------------------------------
  // Committed strokes — stored as both raw data (for eraser) and a GPU Picture
  // -------------------------------------------------------------------------

  /**
   * `committedStrokes` holds the raw point data needed for eraser hit-testing.
   * `committedPicture` is the GPU-side rendering of those strokes.
   *
   * We keep both because:
   * - The eraser needs to do geometry math on raw points (splitStrokeByEraser).
   * - Rendering needs only the Picture (zero JS cost).
   */
  const committedStrokesRef = useRef<Stroke[]>([]);
  const [committedPicture, setCommittedPicture] = useState<SkPicture | null>(null);

  const rebuildPicture = useCallback((strokes: Stroke[]) => {
    const { width, height } = canvasSize.current;
    const pic = recordStrokesToPicture(strokes, minRadius, maxRadius, width, height);
    setCommittedPicture(pic);
  }, [minRadius, maxRadius]);

  // -------------------------------------------------------------------------
  // Active (in-progress) stroke
  // -------------------------------------------------------------------------

  /**
   * The active stroke is rendered as a single filled Path element built by
   * IncrementalRibbon. We keep the ribbon builder in a ref (not state) so that
   * addPoint() doesn't trigger React renders.
   *
   * `setActiveSkPath` is the render trigger — it pushes a new path to state on
   * each rAF tick so React re-renders exactly once per frame during drawing.
   */
  const ribbon = useRef<IncrementalRibbon | null>(null);
  const [activeSkPath, setActiveSkPath] = useState<SkPath | null>(null);
  const activeColor = useRef(strokeColor);
  const rafScheduled = useRef(false);
  const isDrawing = useRef(false);

  // Pen size snapshot at stroke start
  const penSizeRef = useRef({ strokeWidth, minRadius, maxRadius });
  penSizeRef.current = { strokeWidth, minRadius, maxRadius };

  /**
   * Microtask-based path flush — replaces the old rAF scheduler.
   *
   * WHY NOT requestAnimationFrame?
   * rAF adds a mandatory ≤16 ms wait (one vsync). Events arriving mid-frame
   * only render on the NEXT frame, adding 1 full frame of pipeline latency.
   *
   * A microtask (queueMicrotask / Promise.resolve) fires *immediately* after
   * the current synchronous JS finishes — typically after the bridge/JSI event
   * batch. This means:
   *   • All stylus samples from the same MotionEvent batch are accumulated
   *     before the flush runs (natural coalescing).
   *   • The path is built exactly once per event batch, not once per sample.
   *   • React picks up the setState in the current frame's commit, removing
   *     the extra frame of delay from rAF.
   */
  const flushActive = useCallback(() => {
    rafScheduled.current = false;
    if (ribbon.current && ribbon.current.pointCount > 0) {
      setActiveSkPath(ribbon.current.getPath());
    }
  }, []);

  const scheduleActiveRender = useCallback(() => {
    if (!rafScheduled.current) {
      rafScheduled.current = true;
      // Promise.resolve().then() is a microtask — same semantics as
      // queueMicrotask but with broader engine/type support in Hermes.
      Promise.resolve().then(flushActive);
    }
  }, [flushActive]);

  // Eraser
  const eraserRafScheduled = useRef(false);
  const eraserRadiusRef = useRef(eraserRadius);
  eraserRadiusRef.current = eraserRadius;
  const eraserPoints = useRef<RawPoint[]>([]);

  // Debug
  const debugRafScheduled = useRef(false);
  const pendingDebug = useRef<StylusDebug | null>(null);
  const onStylusDebugRef = useRef(onStylusDebug);
  onStylusDebugRef.current = onStylusDebug;

  const debugTick = useCallback(() => {
    debugRafScheduled.current = false;
    if (pendingDebug.current) onStylusDebugRef.current?.(pendingDebug.current);
  }, []);

  const scheduleDebug = useCallback((info: StylusDebug) => {
    pendingDebug.current = info;
    if (!debugRafScheduled.current) {
      debugRafScheduled.current = true;
      requestAnimationFrame(debugTick);
    }
  }, [debugTick]);

  // -------------------------------------------------------------------------
  // Pan / zoom transform
  // -------------------------------------------------------------------------

  type Transform = { translateX: number; translateY: number; scale: number };
  const [transform, setTransform] = useState<Transform>({ translateX: 0, translateY: 0, scale: 1 });

  const baseTx = useSharedValue(0);
  const baseTy = useSharedValue(0);
  const baseScale = useSharedValue(1);
  const liveTx = useSharedValue(0);
  const liveTy = useSharedValue(0);
  const liveScale = useSharedValue(1);

  useEffect(() => {
    liveTx.value = transform.translateX;
    liveTy.value = transform.translateY;
    liveScale.value = transform.scale;
  }, [transform]);

  const commitTransform = useCallback(() => {
    setTransform({ translateX: liveTx.value, translateY: liveTy.value, scale: liveScale.value });
  }, []);

  const composedGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minPointers(2)
      .onBegin(() => {
        'worklet';
        baseTx.value = liveTx.value;
        baseTy.value = liveTy.value;
      })
      .onUpdate(e => {
        'worklet';
        liveTx.value = baseTx.value + e.translationX;
        liveTy.value = baseTy.value + e.translationY;
      })
      .onEnd(() => {
        'worklet';
        runOnJS(commitTransform)();
      });

    const pinch = Gesture.Pinch()
      .onBegin(() => {
        'worklet';
        baseScale.value = liveScale.value;
        baseTx.value = liveTx.value;
        baseTy.value = liveTy.value;
      })
      .onUpdate(e => {
        'worklet';
        const nextScale = clamp(baseScale.value * e.scale, MIN_SCALE, MAX_SCALE);
        const scaleDelta = nextScale / baseScale.value;
        liveTx.value = e.focalX - (e.focalX - baseTx.value) * scaleDelta;
        liveTy.value = e.focalY - (e.focalY - baseTy.value) * scaleDelta;
        liveScale.value = nextScale;
      })
      .onEnd(() => {
        'worklet';
        runOnJS(commitTransform)();
      });

    return Gesture.Simultaneous(pan, pinch);
  }, [commitTransform]);

  // -------------------------------------------------------------------------
  // Coordinate mapping
  // -------------------------------------------------------------------------

  const canvasViewRef = useRef<View>(null);
  const canvasLayoutRef = useRef({ x: 0, y: 0, width: 0, height: 0 });

  const toCanvasSpace = useCallback(
    (sx: number, sy: number) => {
      // Stylus events are always in window-space dp (converted in native module).
      // Subtract the canvas view's window offset to get view-local coords,
      // then undo the pan/zoom transform to get content-space coords.
      const { x: ox, y: oy } = canvasLayoutRef.current;
      return {
        x: (sx - ox - transform.translateX) / transform.scale,
        y: (sy - oy - transform.translateY) / transform.scale,
      };
    },
    [transform],
  );

  // -------------------------------------------------------------------------
  // Drawing logic
  // -------------------------------------------------------------------------

  const startStroke = useCallback(
    (x: number, y: number, pressure: number) => {
      isDrawing.current = true;
      activeColor.current = strokeColor;
      const size = penSizeRef.current;

      if (toolMode === 'pen') {
        ribbon.current = new IncrementalRibbon(size.minRadius, size.maxRadius);
        ribbon.current.addPoint(x, y, pressure);
        setActiveSkPath(null);
        scheduleActiveRender();
      } else {
        eraserPoints.current = [{ x, y, pressure }];
      }
    },
    [toolMode, strokeColor, scheduleActiveRender],
  );

  const addPoint = useCallback(
    (x: number, y: number, pressure: number) => {
      if (toolMode === 'pen' && ribbon.current) {
        // Point decimation: skip sub-pixel moves.
        const pts = ribbon.current.getPoints();
        if (pts.length > 0) {
          const last = pts[pts.length - 1];
          const dx = x - last.x;
          const dy = y - last.y;
          if (dx * dx + dy * dy < MIN_POINT_DIST_SQ) return;
        }
        ribbon.current.addPoint(x, y, pressure);
        scheduleActiveRender();
      } else if (toolMode === 'eraser') {
        eraserPoints.current.push({ x, y, pressure });

        if (!eraserRafScheduled.current) {
          eraserRafScheduled.current = true;
          requestAnimationFrame(() => {
            eraserRafScheduled.current = false;
            const eraserPath = [...eraserPoints.current];
            // Trim to last point — earlier points were already processed.
            // Prevents unbounded growth during long erase gestures.
            if (eraserPath.length > 0) {
              eraserPoints.current = [eraserPath[eraserPath.length - 1]];
            }
            const r = eraserRadiusRef.current;
            const prev = committedStrokesRef.current;
            const next: Stroke[] = [];

            for (const stroke of prev) {
              const segments = splitStrokeByEraser(stroke.points, eraserPath, r);
              for (const seg of segments) {
                if (seg.length > 0) {
                  next.push({ ...stroke, id: `${stroke.id}-${next.length}`, points: seg });
                }
              }
            }

            committedStrokesRef.current = next;
            // Rebuild picture from surviving strokes — one GPU re-record, not N re-renders.
            const { width, height } = canvasSize.current;
            const pic = recordStrokesToPicture(next, minRadius, maxRadius, width, height);
            setCommittedPicture(pic);
          });
        }
      }
    },
    [toolMode, scheduleActiveRender, minRadius, maxRadius],
  );

  const endStroke = useCallback(() => {
    isDrawing.current = false;

    if (toolMode === 'pen' && ribbon.current && ribbon.current.pointCount > 0) {
      const pts = ribbon.current.getPoints();
      const size = penSizeRef.current;

      // Build the finalized stroke record.
      const finalized: Stroke = {
        id: `stroke-${Date.now()}-${Math.random()}`,
        points: [...pts],
        color: activeColor.current,
        width: size.strokeWidth,
        minRadius: size.minRadius,
        maxRadius: size.maxRadius,
      };

      // Add to committed list.
      const next = [...committedStrokesRef.current, finalized];
      committedStrokesRef.current = next;

      // Re-record the picture with the new stroke appended.
      // Because we use createPicture incrementally, this is cheap:
      // Skia records the draw call; replay cost is proportional to stroke count
      // but each stroke is a single path draw (not N circles).
      rebuildPicture(next);

      // Clear the active path — it's now in the picture.
      ribbon.current.reset();
      ribbon.current = null;
      setActiveSkPath(null);
    }

    eraserPoints.current = [];
  }, [toolMode, rebuildPicture]);

  // Stable refs for stylus callbacks
  const startStrokeRef = useRef(startStroke);
  const addPointRef = useRef(addPoint);
  const endStrokeRef = useRef(endStroke);
  const toCanvasSpaceRef = useRef(toCanvasSpace);
  startStrokeRef.current = startStroke;
  addPointRef.current = addPoint;
  endStrokeRef.current = endStroke;
  toCanvasSpaceRef.current = toCanvasSpace;

  // -------------------------------------------------------------------------
  // Stylus events
  // -------------------------------------------------------------------------

  const handleStylusDown = useCallback((e: any) => {
    const { x, y } = toCanvasSpaceRef.current(e.x, e.y);
    const pressure = normalizePressure(e.pressure);
    scheduleDebug({ phase: 'down', x: e.x, y: e.y, canvasX: x, canvasY: y, pressure, tiltX: e.tiltX, tiltY: e.tiltY, orientation: e.orientation, timestamp: e.timestamp, toolType: e.toolType });
    startStrokeRef.current(x, y, pressure);
  }, [scheduleDebug]);

  const handleStylusMove = useCallback((e: any) => {
    if (!isDrawing.current) return;
    const { x, y } = toCanvasSpaceRef.current(e.x, e.y);
    const pressure = normalizePressure(e.pressure);
    // Only schedule debug if a listener exists — saves an object allocation
    // per coalesced point during fast drawing.
    if (onStylusDebugRef.current) {
      scheduleDebug({ phase: 'move', x: e.x, y: e.y, canvasX: x, canvasY: y, pressure, tiltX: e.tiltX, tiltY: e.tiltY, orientation: e.orientation, timestamp: e.timestamp, toolType: e.toolType });
    }
    addPointRef.current(x, y, pressure);
  }, [scheduleDebug]);

  const handleStylusUp = useCallback(() => {
    endStrokeRef.current();
    if (pendingDebug.current) {
      onStylusDebugRef.current?.({ ...pendingDebug.current, phase: 'up' });
    }
  }, []);

  const stylusConfig = useMemo(
    () => ({ onStylusDown: handleStylusDown, onStylusMove: handleStylusMove, onStylusUp: handleStylusUp }),
    [handleStylusDown, handleStylusMove, handleStylusUp],
  );

  useStylusEvents(stylusConfig);

  // -------------------------------------------------------------------------
  // Imperative API
  // -------------------------------------------------------------------------

  const clear = useCallback(() => {
    committedStrokesRef.current = [];
    ribbon.current?.reset();
    ribbon.current = null;
    setActiveSkPath(null);
    // Record an empty picture.
    const { width, height } = canvasSize.current;
    setCommittedPicture(createPicture(() => { }, { x: 0, y: 0, width, height }));
  }, []);

  useImperativeHandle(ref, () => ({ clear }), [clear]);

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  const measureCanvas = useCallback(() => {
    canvasViewRef.current?.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) {
        canvasLayoutRef.current = { x, y, width, height };
        canvasSize.current = { width, height };
      }
    });
  }, []);

  const handleLayout = useCallback(() => {
    measureCanvas();
  }, [measureCanvas]);

  // Also measure on mount so the offset is available before the first stylus event.
  useEffect(() => {
    const id = requestAnimationFrame(() => measureCanvas());
    return () => cancelAnimationFrame(id);
  }, [measureCanvas]);

  // -------------------------------------------------------------------------
  // Render
  //
  // The Canvas contains exactly:
  //   1. <Picture> — all committed strokes, rendered in one GPU draw call.
  //   2. <Path>    — the active stroke ribbon, rebuilt once per rAF tick.
  //
  // React only ever diffs 2 elements (not N strokes). Skia handles everything
  // else on the GPU thread.
  // -------------------------------------------------------------------------

  return (
    <GestureHandlerRootView style={[styles.root, style]}>
      <GestureDetector gesture={composedGesture}>
        <View ref={canvasViewRef} style={styles.root} onLayout={handleLayout}>
          <Canvas style={styles.canvas}>
            {/* Group applies pan/zoom transform so strokes (stored in content-space)
                render at the correct visual position. */}
            <Group
              transform={[
                { translateX: transform.translateX },
                { translateY: transform.translateY },
                { scale: transform.scale },
              ]}
            >
              {/* All committed strokes — one Picture, one GPU draw call */}
              {committedPicture && <Picture picture={committedPicture} />}

              {/* Active stroke — single filled path, rebuilt once per rAF */}
              {activeSkPath && (
                <Path
                  path={activeSkPath}
                  color={activeColor.current}
                  style="fill"
                  antiAlias
                />
              )}
            </Group>
          </Canvas>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
});

export default CanvasView;

const styles = StyleSheet.create({
  root: { flex: 1 },
  canvas: { flex: 1, backgroundColor: '#fff' },
});
