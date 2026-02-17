/**
 * Core data types for the drawing system.
 *
 * A `Point` is a single stylus sample, storing position and optionally pressure/tilt/time.
 * A `Stroke` is an ordered list of points captured between pen-down and pen-up, with
 * rendering metadata (color, width) snapshotted at stroke start so toolbar changes
 * don't retroactively alter existing ink.
 */

export type Point = {
  x: number;
  y: number;
  /** Normalized pressure in [0..1]. Absent means no pressure data (treated as 0.5). */
  pressure?: number;
  /** Stylus tilt in degrees, if available. */
  tilt?: number;
  /** Timestamp in ms, if available. */
  time?: number;
};

export type Stroke = {
  id: string;
  points: Point[];
  /** Ink color captured when the stroke began. */
  color: string;
  /** Constant stroke width (used when !hasPressure). */
  width: number;
  /** Minimum circle radius for pressure-sensitive rendering. */
  minRadius: number;
  /** Maximum circle radius for pressure-sensitive rendering. */
  maxRadius: number;
};

/** Create an empty stroke with sensible defaults. */
export function createStroke(
  id: string,
  color = '#111',
  width = 2.5,
  minRadius = 0.5,
  maxRadius = 14,
): Stroke {
  return { id, points: [], color, width, minRadius, maxRadius };
}
