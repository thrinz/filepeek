import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import {
  addPermLink,
  authHeaders,
  canPermLink,
  downloadUrl,
  fetchFile,
  permLinkUrl,
  previewUrl,
  relogin,
} from '../api';
import { Editor } from './Editor';
import type { Connection } from '../storage';
import { colors } from '../theme';

/** Above this, a phone text field gets too slow to type in. */
const MAX_EDIT_BYTES = 1024 * 1024;

/** `key` changes each time a file is opened and survives a rename. */
export type OpenFile = { key: number; path: string; name: string };

/** The right pane: a WebView on the server's /api/preview page, plus file actions. */
export function Viewer({
  conn,
  file,
  onClose,
  showBack,
  onDirtyChange,
  onError,
}: {
  conn: Connection;
  file: OpenFile | null;
  onClose: () => void;
  /** Phone layout: the viewer covers the list, so show a back button. */
  showBack: boolean;
  /** Reports whether the editor holds unsaved changes. */
  onDirtyChange: (dirty: boolean) => void;
  onError: (e: unknown) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [opening, setOpening] = useState(false);
  // Tagged with the opening it belongs to, so opening a file (even the same
  // one again) always lands back in the viewer.
  const [editing, setEditing] = useState<{ key: number; content: string } | null>(null);

  if (!file) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.bg }]}>
        <Text style={{ color: colors.muted, fontSize: 15 }}>Select a file to view it</Text>
      </View>
    );
  }

  const download = async () => {
    setDownloading(true);
    try {
      // Fetch into the app cache, then hand off to the system share sheet
      // ("Save to Files", "Open in…", etc.).
      const saved = await File.downloadFileAsync(downloadUrl(conn, file.path), new File(Paths.cache, file.name), {
        headers: authHeaders(conn),
        idempotent: true,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(saved.uri, { dialogTitle: file.name });
      } else {
        Alert.alert('Downloaded', saved.uri);
      }
    } catch (e) {
      onError(e);
    } finally {
      setDownloading(false);
    }
  };

  const edit = async () => {
    setOpening(true);
    try {
      const f = await fetchFile(conn, file.path);
      if (!f.is_text || f.content === null) {
        Alert.alert("Can't edit this file", 'Only text files can be edited here.');
      } else if (f.size > MAX_EDIT_BYTES) {
        Alert.alert("Can't edit this file", 'It is too large to edit on a phone (over 1 MB).');
      } else {
        setEditing({ key: file.key, content: f.content });
      }
    } catch (e) {
      onError(e);
    } finally {
      setOpening(false);
    }
  };

  if (editing?.key === file.key) {
    return (
      <Editor
        conn={conn}
        path={file.path}
        name={file.name}
        initial={editing.content}
        onDirtyChange={onDirtyChange}
        onDone={(saved) => {
          setEditing(null);
          if (saved) setReloadKey((k) => k + 1);
        }}
        onError={onError}
      />
    );
  }

  const permLink = async () => {
    try {
      await addPermLink(conn, file.path);
      const url = permLinkUrl(conn, file.path);
      await Clipboard.setStringAsync(url);
      Alert.alert('Perm link copied', url);
    } catch (e) {
      onError(e);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[styles.bar, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {showBack && (
          <Pressable onPress={onClose} hitSlop={10} style={styles.barBtn}>
            <Text style={{ color: colors.link, fontSize: 16 }}>‹ Back</Text>
          </Pressable>
        )}
        <Text style={[styles.name, { color: colors.fg }]} numberOfLines={1}>
          {file.name}
        </Text>
        <Pressable
          onPress={() => setReloadKey((k) => k + 1)}
          hitSlop={6}
          style={styles.barBtn}
          accessibilityLabel="Reload">
          <Text style={{ color: colors.link, fontSize: 18 }}>↻</Text>
        </Pressable>
        <Pressable onPress={edit} disabled={opening} hitSlop={6} style={styles.barBtn}>
          {opening ? <ActivityIndicator color={colors.link} size="small" /> : <Text style={{ color: colors.link }}>Edit</Text>}
        </Pressable>
        {canPermLink(file.name) && (
          <Pressable onPress={permLink} hitSlop={6} style={styles.barBtn}>
            <Text style={{ color: colors.link }}>Perm link</Text>
          </Pressable>
        )}
        <Pressable onPress={download} disabled={downloading} hitSlop={6} style={styles.barBtn}>
          {downloading ? <ActivityIndicator color={colors.link} size="small" /> : <Text style={{ color: colors.link }}>Download</Text>}
        </Pressable>
      </View>
      <WebView
        key={`${file.key}#${file.path}#${reloadKey}`}
        // The Bearer header only rides on this first request; the server answers
        // it with a session cookie so images/PDF data inside the page load too.
        source={{ uri: previewUrl(conn, file.path), headers: authHeaders(conn) }}
        sharedCookiesEnabled
        startInLoadingState
        renderLoading={() => (
          <View style={[StyleSheet.absoluteFill, styles.empty, { backgroundColor: colors.bg }]}>
            <ActivityIndicator color={colors.link} />
          </View>
        )}
        onHttpError={({ nativeEvent }) => {
          if (!nativeEvent.url.includes('/api/preview')) return;
          if (nativeEvent.statusCode === 401) {
            // Token expired: sign in again from the stored credential, then retry.
            relogin(conn)
              .then(() => setReloadKey((k) => k + 1))
              .catch(onError);
          } else {
            onError(new Error(`Could not open ${file.name} (HTTP ${nativeEvent.statusCode})`));
          }
        }}
        style={{ flex: 1, backgroundColor: colors.bg }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    minHeight: 46,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  name: { flex: 1, fontSize: 15, fontWeight: '600', paddingHorizontal: 6 },
});
