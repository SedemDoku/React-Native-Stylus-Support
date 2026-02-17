import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  PanResponder,
} from 'react-native';

/**
 * A lightweight horizontal slider for brush/eraser size controls.
 *
 * Uses PanResponder + measureInWindow so it works correctly even inside scroll views
 * (pageX provides screen-space coordinates that align with the measured track position).
 */
type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  onValueChange: (value: number) => void;
  valueLabel?: (v: number) => string;
};

const SLIDER_HEIGHT = 28;
const THUMB_SIZE = 22;

export default function SizeSlider({
  label,
  value,
  min,
  max,
  onValueChange,
  valueLabel = v => Math.round(v).toString(),
}: Props) {
  const trackWrapRef = useRef<View>(null);
  const [trackWidth, setTrackWidth] = useState(200);
  const trackLayoutRef = useRef({ x: 0, width: 200 });
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const onLayout = () => {
    trackWrapRef.current?.measureInWindow((x, _y, width) => {
      if (width > 0) {
        setTrackWidth(width);
        trackLayoutRef.current = { x, width };
      }
    });
  };

  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  const thumbLeft = Math.max(0, Math.min(trackWidth - THUMB_SIZE, ratio * trackWidth - THUMB_SIZE / 2));

  const updateFromPageX = (pageX: number) => {
    const { x, width } = trackLayoutRef.current;
    const xInTrack = pageX - x;
    const r = width > 0 ? Math.max(0, Math.min(1, xInTrack / width)) : 0;
    onValueChange(clamp(min + r * (max - min)));
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: evt => updateFromPageX(evt.nativeEvent.pageX),
      onPanResponderMove: evt => updateFromPageX(evt.nativeEvent.pageX),
    }),
  ).current;

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.valueText}>{valueLabel(value)}</Text>
      </View>
      <View
        ref={trackWrapRef}
        style={styles.trackWrap}
        onLayout={onLayout}
        {...panResponder.panHandlers}
      >
        <View style={styles.track} />
        <View
          style={[
            styles.thumb,
            {
              left: thumbLeft,
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              borderRadius: THUMB_SIZE / 2,
              top: (SLIDER_HEIGHT - THUMB_SIZE) / 2,
            },
          ]}
          pointerEvents="none"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 120 },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  label: { fontSize: 12, color: '#666', fontWeight: '500' },
  valueText: { fontSize: 12, color: '#333', fontWeight: '600' },
  trackWrap: { height: SLIDER_HEIGHT, justifyContent: 'center', position: 'relative' },
  track: { height: 6, borderRadius: 3, backgroundColor: '#e0e0e0' },
  thumb: { position: 'absolute', backgroundColor: '#333' },
});
