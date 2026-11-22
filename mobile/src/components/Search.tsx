import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { parentPath, searchContent, searchFilename, type SearchHit } from '../api';
import type { Connection } from '../storage';
import { colors } from '../theme';

type Mode = 'name' | 'content';
type Props = {
  conn: Connection;
  onClose: () => void;
  onOpen: (path: string, name: string) => void;
  onError: (e: unknown) => void;
};

/** Shortest query the server accepts for each kind of search. */
const MIN_CHARS: Record<Mode, number> = { name: 1, content: 2 };
const DEBOUNCE_MS = 350;

export function Search({ visible, ...props }: Props & { visible: boolean }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={props.onClose}>
      {/* Mounted per opening, so each search starts clean. */}
      {visible && <SearchPanel {...props} />}
    </Modal>
  );
}

function SearchPanel({ conn, onClose, onOpen, onError }: Props) {
  const [mode, setMode] = useState<Mode>('name');
  const [query, setQuery] = useState('');
  // Tagged with the search they answer, so results for an older query or the
  // other mode are never shown under the current one.
  const [found, setFound] = useState<{ key: string; hits: SearchHit[] } | null>(null);

  const q = query.trim();
  const ready = q.length >= MIN_CHARS[mode];
  const key = `${mode}:${q}`;
  const hits = ready && found?.key === key ? found.hits : null;

  useEffect(() => {
    if (!ready) return;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const hits = await (mode === 'name' ? searchFilename(conn, q) : searchContent(conn, q));
        if (current) setFound({ key, hits });
      } catch (e) {
        if (current) {
          setFound({ key, hits: [] });
          onError(e);
        }
      }
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [conn, mode, q, key, ready, onError]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder={mode === 'name' ? 'Search file names' : 'Search inside files'}
          placeholderTextColor={colors.muted}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={{ color: colors.link, fontSize: 16 }}>Done</Text>
        </Pressable>
      </View>

      <View style={styles.tabs}>
        {(['name', 'content'] as Mode[]).map((m) => (
          <Pressable key={m} onPress={() => setMode(m)} style={[styles.tab, mode === m && styles.tabActive]}>
            <Text style={[styles.tabText, mode === m && styles.tabTextActive]}>
              {m === 'name' ? 'File names' : 'File contents'}
            </Text>
          </Pressable>
        ))}
      </View>

      {!ready ? (
        <Text style={styles.note}>
          {mode === 'name'
            ? 'Searches every folder you can see.'
            : 'Type at least 2 characters. Searches text files up to 1 MB.'}
        </Text>
      ) : hits === null ? (
        <ActivityIndicator color={colors.link} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={hits}
          keyExtractor={(h) => h.path}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={styles.note}>No matches</Text>}
          ListFooterComponent={
            hits.length >= 50 ? <Text style={styles.note}>Showing the first 50 matches — refine the search.</Text> : undefined
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => {
                onClose();
                onOpen(item.path, item.name);
              }}>
              <Text style={{ color: colors.fg, fontSize: 16 }} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>
                /{parentPath(item.path)}
              </Text>
              {item.snippet !== undefined && (
                <Text style={styles.snippet} numberOfLines={2}>
                  <Text style={{ color: colors.muted }}>{item.line}: </Text>
                  {item.snippet}
                </Text>
              )}
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  input: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    color: colors.fg,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    overflow: 'hidden',
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  tabActive: { backgroundColor: colors.accent },
  tabText: { color: colors.muted, fontWeight: '600' },
  tabTextActive: { color: colors.accentFg },
  note: { color: colors.muted, textAlign: 'center', padding: 28, lineHeight: 20 },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  snippet: { color: colors.fg, fontSize: 12, marginTop: 4, fontFamily: 'Courier' },
});
