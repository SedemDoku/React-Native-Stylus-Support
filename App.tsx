import React from 'react';
import { StatusBar, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import EditorScreen from './src/screens/EditorScreen';

export default function App() {
    return (
        <GestureHandlerRootView style={styles.container}>
            <StatusBar barStyle="dark-content" />
            <EditorScreen />
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
});
