import { useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { connect, resume } from '../api';
import type { Connection } from '../storage';
import { colors } from '../theme';

type Mode = 'password' | 'apikey';

export default function ConnectScreen({ onConnected }: { onConnected: (conn: Connection) => void }) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<Mode>('password');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const secretRef = useRef<ComponentRef<typeof TextInput>>(null);

  // On launch, try to silently resume a saved connection. If the server can't
  // be reached right now, keep the saved details in the form instead of
  // dropping them.
  useEffect(() => {
    let alive = true;
    resume().then((r) => {
      if (!alive) return;
      if (r.status === 'ok') {
        onConnected(r.conn);
        return;
      }
      if (r.status === 'failed') {
        setUrl(r.conn.base);
        if (r.conn.mode !== 'none') setMode(r.conn.mode);
        setSecret(r.conn.secret);
        setError(r.message);
      }
      setChecking(false);
    });
    return () => {
      alive = false;
    };
  }, [onConnected]);

  async function onConnect() {
    setError('');
    setBusy(true);
    try {
      onConnected(await connect(url, mode, secret));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect.");
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Image source={require('../../assets/icon.png')} style={styles.logo} />
          <Text style={styles.title}>filepeek</Text>
          <Text style={styles.hint}>Connect to the machine that runs your filepeek server.</Text>

          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="box.tailnet.ts.net"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            returnKeyType="next"
            onSubmitEditing={() => secretRef.current?.focus()}
          />

          <View style={styles.tabs}>
            {(['password', 'apikey'] as Mode[]).map((m) => (
              <Pressable
                key={m}
                onPress={() => {
                  if (m !== mode) setSecret('');
                  setMode(m);
                }}
                style={[styles.tab, mode === m && styles.tabActive]}>
                <Text style={[styles.tabText, mode === m && styles.tabTextActive]}>
                  {m === 'password' ? 'Password' : 'API key'}
                </Text>
              </Pressable>
            ))}
          </View>

          <TextInput
            ref={secretRef}
            style={styles.input}
            value={secret}
            onChangeText={setSecret}
            placeholder={mode === 'password' ? 'Password' : 'API key'}
            placeholderTextColor={colors.muted}
            secureTextEntry={mode === 'password'}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType={mode === 'password' ? 'password' : 'none'}
            returnKeyType="go"
            onSubmitEditing={onConnect}
          />

          {!!error && <Text style={styles.error}>{error}</Text>}

          <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={onConnect} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect</Text>}
          </Pressable>

          <Text style={styles.footnote}>
            Your phone needs to be able to reach the server — usually by running Tailscale on both. A bare host name
            tries HTTPS first, then HTTP; add a port if you need one (box:8765). Leave the password blank if the
            server has no login.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  center: { alignItems: 'center', justifyContent: 'center' },
  card: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  logo: { width: 56, height: 56, alignSelf: 'center', borderRadius: 12 },
  title: { color: colors.fg, fontSize: 20, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  hint: { color: colors.muted, fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: 12 },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    color: colors.fg,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginTop: 10,
  },
  tabs: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 14,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9 },
  tabActive: { backgroundColor: colors.accent },
  tabText: { color: colors.muted, fontWeight: '600' },
  tabTextActive: { color: colors.accentFg },
  error: { color: colors.danger, fontSize: 13, marginTop: 10 },
  button: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 13, alignItems: 'center', marginTop: 16 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  footnote: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 16 },
});
