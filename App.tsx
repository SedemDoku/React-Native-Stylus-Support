import React from 'react';
import { StatusBar, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { useStylusEvents } from 'react-native-stylus-events';

export default function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [info, setInfo] = React.useState('Touch with stylus...');

  const formatEvent = (
    label: string,
    e: { x: number; y: number; pressure: number; tiltX: number; tiltY: number; orientation: number }
  ) =>
    `${label}\n` +
    `X: ${e.x.toFixed(0)}  Y: ${e.y.toFixed(0)}\n` +
    `Pressure: ${e.pressure.toFixed(2)}\n` +
    `TiltX: ${e.tiltX.toFixed(2)}  TiltY: ${e.tiltY.toFixed(2)}\n` +
    `Orientation: ${e.orientation.toFixed(2)}`;

  useStylusEvents({
    onStylusDown: (e) => setInfo(formatEvent('Stylus down', e)),
    onStylusMove: (e) => setInfo(formatEvent('Stylus move', e)),
    onStylusUp: () => setInfo('Stylus up'),
  });

  return (
    <View style={styles.container}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <Text style={styles.title}>Stylus Events Test</Text>
      <Text style={styles.info}>{info}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 12,
  },
  info: {
    fontSize: 18,
  },
});
