import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import ConnectScreen from './src/screens/ConnectScreen';
import FilesScreen from './src/screens/FilesScreen';
import { clearConnection, type Connection } from './src/storage';
import { colors } from './src/theme';

// Two screens, one switch: Connect (which also resumes a saved connection on
// launch) and Files. Too little navigation to need a router.
export default function App() {
  const [conn, setConn] = useState<Connection | null>(null);

  const disconnect = useCallback(() => {
    clearConnection().catch(() => {});
    setConn(null);
  }, []);
  // Keeps the saved connection, so Connect comes back pre-filled with the reason.
  const authLost = useCallback(() => setConn(null), []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1, backgroundColor: conn ? colors.card : colors.bg }}>
        {conn ? (
          <FilesScreen conn={conn} onDisconnect={disconnect} onAuthLost={authLost} />
        ) : (
          <ConnectScreen onConnected={setConn} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
