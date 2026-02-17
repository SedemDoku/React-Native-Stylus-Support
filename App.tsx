import React from 'react';
import { StatusBar, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import { useStylusEvents } from 'react-native-stylus-events-local';

type StylusPoint = {
    x: number;
    y: number;
    pressure: number;
    tiltX: number;
    tiltY: number;
    orientation: number;
};

type Stroke = {
    points: StylusPoint[];
};

const MIN_STROKE = 2;
const MAX_STROKE = 14;

const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));

const pressureToWidth = (pressure: number) => {
    const normalized = clamp(pressure, 0, 1);
    return MIN_STROKE + (MAX_STROKE - MIN_STROKE) * normalized;
};

export default function App() {
    const isDarkMode = useColorScheme() === 'dark';
    const [info, setInfo] = React.useState('Touch with stylus...');
    const [strokes, setStrokes] = React.useState<Stroke[]>([]);
    const activeStrokeIndex = React.useRef<number | null>(null);

    const formatEvent = (label: string, e: StylusPoint) =>
        `${label}\n` +
        `X: ${e.x.toFixed(0)}  Y: ${e.y.toFixed(0)}\n` +
        `Pressure: ${e.pressure.toFixed(2)}\n` +
        `TiltX: ${e.tiltX.toFixed(2)}  TiltY: ${e.tiltY.toFixed(2)}\n` +
        `Orientation: ${e.orientation.toFixed(2)}`;

    const addPointToActiveStroke = (point: StylusPoint) => {
        const strokeIndex = activeStrokeIndex.current;
        if (strokeIndex === null) return;

        setStrokes((prev) => {
            if (!prev[strokeIndex]) return prev;
            const next = [...prev];
            const stroke = next[strokeIndex];
            next[strokeIndex] = { points: [...stroke.points, point] };
            return next;
        });
    };

    useStylusEvents({
        onStylusDown: (e) => {
            const point: StylusPoint = {
                x: e.x,
                y: e.y,
                pressure: e.pressure,
                tiltX: e.tiltX,
                tiltY: e.tiltY,
                orientation: e.orientation,
            };
            setStrokes((prev) => {
                const next = [...prev, { points: [point] }];
                activeStrokeIndex.current = next.length - 1;
                return next;
            });
            setInfo(formatEvent('Stylus down', point));
        },
        onStylusMove: (e) => {
            const point: StylusPoint = {
                x: e.x,
                y: e.y,
                pressure: e.pressure,
                tiltX: e.tiltX,
                tiltY: e.tiltY,
                orientation: e.orientation,
            };
            addPointToActiveStroke(point);
            setInfo(formatEvent('Stylus move', point));
        },
        onStylusUp: () => {
            activeStrokeIndex.current = null;
            setInfo('Stylus up');
        },
    });

    return (
        <View style={styles.container}>
            <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
            <View style={styles.header}>
                <Text style={styles.title}>Stylus Bezier Canvas</Text>
                <Text style={styles.info}>{info}</Text>
            </View>
            <Canvas style={styles.canvas}>
                {strokes.map((stroke, strokeIndex) => {
                    const { points } = stroke;
                    if (points.length === 0) return null;

                    if (points.length === 1) {
                        const p = points[0];
                        return (
                            <Circle
                                key={`dot-${strokeIndex}`}
                                cx={p.x}
                                cy={p.y}
                                r={pressureToWidth(p.pressure) / 2}
                                color="#1f2937"
                            />
                        );
                    }

                    const segments = [] as JSX.Element[];
                    for (let i = 1; i < points.length; i += 1) {
                        const p0 = points[i - 1];
                        const p1 = points[i];
                        const midX = (p0.x + p1.x) / 2;
                        const midY = (p0.y + p1.y) / 2;
                        const path = Skia.Path.Make();
                        path.moveTo(p0.x, p0.y);
                        path.quadTo(p0.x, p0.y, midX, midY);

                        const strokeWidth = pressureToWidth((p0.pressure + p1.pressure) / 2);
                        segments.push(
                            <Path
                                key={`seg-${strokeIndex}-${i}`}
                                path={path}
                                color="#111827"
                                style="stroke"
                                strokeWidth={strokeWidth}
                                strokeCap="round"
                                strokeJoin="round"
                            />
                        );
                    }

                    return segments;
                })}
            </Canvas>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f8fafc',
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 12,
    },
    title: {
        fontSize: 20,
        fontWeight: '600',
        marginBottom: 6,
    },
    info: {
        fontSize: 14,
        color: '#334155',
    },
    canvas: {
        flex: 1,
        backgroundColor: '#ffffff',
    },
});
