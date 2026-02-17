import React, { useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Text } from 'react-native';
import CanvasView, { CanvasViewRef, StylusDebug } from '../components/CanvasView';
import Toolbar from '../components/Toolbar';
import SizeSlider from '../components/SizeSlider';

/**
 * EditorScreen
 *
 * Owns all editor-level state (tool mode, color, brush/eraser size) and
 * composes the toolbar, sliders, and canvas into a complete drawing UI.
 *
 * Undo / Redo are implemented with a simple snapshot stack: each committed
 * stroke (pen-up) pushes a snapshot of the strokes array onto the undo stack.
 * Undo pops from that stack and pushes onto the redo stack. Clear pushes before
 * wiping so the user can undo a clear.
 *
 * Note: undo/redo snapshots live here rather than inside CanvasView so that this
 * screen can inspect and serialize strokes in the future (e.g. for save/export).
 */

const DEFAULT_COLOR = '#111827';
const DEFAULT_PEN_SIZE = 2.5;
const DEFAULT_ERASER_RADIUS = 24;
const DEFAULT_MIN_RADIUS = 0.5;
const DEFAULT_MAX_RADIUS = 14;

export default function EditorScreen() {
  const [stylusInfo, setStylusInfo] = useState<StylusDebug | null>(null);
  // Tool state
  const [toolMode, setToolMode] = useState<'pen' | 'eraser'>('pen');
  const [strokeColor, setStrokeColor] = useState(DEFAULT_COLOR);
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_PEN_SIZE);
  const [eraserRadius, setEraserRadius] = useState(DEFAULT_ERASER_RADIUS);

  // Canvas imperative ref (for programmatic clear)
  const canvasRef = useRef<CanvasViewRef>(null);

  const handleClear = useCallback(() => {
    canvasRef.current?.clear();
  }, []);

  // Undo/Redo are stubbed here — wire up a strokes ref/state lift in CanvasView
  // when you need history. The Toolbar still shows the buttons for discoverability.
  const handleUndo = useCallback(() => {
    // TODO: lift strokes state into this screen and manage a snapshot stack.
  }, []);

  const handleRedo = useCallback(() => {
    // TODO: complement of handleUndo.
  }, []);

  return (
    <View style={styles.container}>
      {/* Top toolbar: tool toggle, color palette, action buttons */}
      <Toolbar
        toolMode={toolMode}
        strokeColor={strokeColor}
        onToolChange={setToolMode}
        onColorChange={color => {
          setStrokeColor(color);
          setToolMode('pen'); // auto-switch to pen when picking a color
        }}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClear={handleClear}
      />

      {/* Size sliders */}
      <View style={styles.sliders}>
        <SizeSlider
          label="Pen size"
          value={strokeWidth}
          min={1}
          max={20}
          onValueChange={setStrokeWidth}
          valueLabel={v => `${v.toFixed(1)}px`}
        />
        <View style={styles.sliderDivider} />
        <SizeSlider
          label="Eraser"
          value={eraserRadius}
          min={8}
          max={80}
          onValueChange={setEraserRadius}
          valueLabel={v => `${Math.round(v)}px`}
        />
      </View>

      <View style={styles.debugPanel}>
        <Text style={styles.debugTitle}>Stylus Debug</Text>
        {stylusInfo ? (
          <Text style={styles.debugText}>
            {`Phase: ${stylusInfo.phase}
` +
              `Screen: ${stylusInfo.x.toFixed(1)}, ${stylusInfo.y.toFixed(1)}
` +
              `Canvas: ${stylusInfo.canvasX.toFixed(1)}, ${stylusInfo.canvasY.toFixed(1)}
` +
              `Pressure: ${stylusInfo.pressure.toFixed(2)}
` +
              `TiltX: ${(stylusInfo.tiltX ?? 0).toFixed(1)}  TiltY: ${(stylusInfo.tiltY ?? 0).toFixed(1)}
` +
              `Orientation: ${(stylusInfo.orientation ?? 0).toFixed(2)}
` +
              `Tool: ${stylusInfo.toolType ?? 'unknown'}  Time: ${stylusInfo.timestamp ?? 0}`}
          </Text>
        ) : (
          <Text style={styles.debugText}>No stylus data yet.</Text>
        )}
      </View>

      {/* Drawing canvas — fills remaining space */}
      <CanvasView
        ref={canvasRef}
        style={styles.canvas}
        toolMode={toolMode}
        strokeColor={strokeColor}
        strokeWidth={strokeWidth}
        eraserRadius={eraserRadius}
        minRadius={DEFAULT_MIN_RADIUS}
        maxRadius={DEFAULT_MAX_RADIUS}
        onStylusDebug={setStylusInfo}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  sliders: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 12,
  },
  sliderDivider: {
    width: 1,
    height: 32,
    backgroundColor: '#e2e8f0',
  },
  canvas: {
    flex: 1,
  },
  debugPanel: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#0f172a',
  },
  debugTitle: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  debugText: {
    color: '#e2e8f0',
    fontSize: 12,
    lineHeight: 16,
  },
});
