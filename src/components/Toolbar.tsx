import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';

/**
 * Editor toolbar.
 *
 * Intentionally "dumb" — it holds no state and only calls the callbacks it receives.
 * The parent screen owns tool state so multiple components can react to changes.
 */

const PALETTE = ['#111827', '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6'];

type Props = {
  toolMode: 'pen' | 'eraser';
  strokeColor: string;
  onToolChange: (mode: 'pen' | 'eraser') => void;
  onColorChange: (color: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onClear?: () => void;
};

export default function Toolbar({
  toolMode,
  strokeColor,
  onToolChange,
  onColorChange,
  onUndo,
  onRedo,
  onClear,
}: Props) {
  return (
    <View style={styles.toolbar}>
      {/* Tool toggle */}
      <View style={styles.group}>
        {(['pen', 'eraser'] as const).map(mode => (
          <TouchableOpacity
            key={mode}
            style={[styles.toolBtn, toolMode === mode && styles.toolBtnActive]}
            onPress={() => onToolChange(mode)}
          >
            <Text style={[styles.toolBtnText, toolMode === mode && styles.toolBtnTextActive]}>
              {mode === 'pen' ? '✏️ Pen' : '🧹 Eraser'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Color palette */}
      <View style={styles.group}>
        {PALETTE.map(color => (
          <TouchableOpacity
            key={color}
            style={[
              styles.swatch,
              { backgroundColor: color },
              strokeColor === color && styles.swatchActive,
            ]}
            onPress={() => onColorChange(color)}
          />
        ))}
      </View>

      {/* Actions */}
      <View style={styles.group}>
        {[
          { label: '↩', onPress: onUndo },
          { label: '↪', onPress: onRedo },
          { label: '🗑', onPress: onClear },
        ].map(({ label, onPress }) => (
          <TouchableOpacity key={label} style={styles.actionBtn} onPress={onPress}>
            <Text style={styles.actionBtnText}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 8,
    flexWrap: 'wrap',
  },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toolBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  toolBtnActive: {
    backgroundColor: '#1e40af',
    borderColor: '#1e40af',
  },
  toolBtnText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '500',
  },
  toolBtnTextActive: {
    color: '#fff',
  },
  swatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  swatchActive: {
    borderColor: '#1e40af',
    transform: [{ scale: 1.25 }],
  },
  actionBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    fontSize: 16,
  },
});
