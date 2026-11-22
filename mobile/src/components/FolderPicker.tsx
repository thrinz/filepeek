import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listDir, parentPath, type Entry } from '../api';
import type { Connection } from '../storage';
import { colors } from '../theme';

type Props = {
  conn: Connection;
  /** The item being moved or copied. */
  source: Entry;
  /** 'Move' or 'Copy' — used for the title and the confirm button. */
  verb: string;
  onCancel: () => void;
  onPick: (destDir: string) => void;
  onError: (e: unknown) => void;
};

/** Choose a destination folder by browsing the tree. */
export function FolderPicker({ source, ...props }: Omit<Props, 'source'> & { source: Entry | null }) {
  return (
    <Modal visible={source !== null} animationType="slide" onRequestClose={props.onCancel}>
      {/* Mounted per opening, so browsing starts from the item's own folder. */}
      {source && <Picker source={source} {...props} />}
    </Modal>
  );
}

function Picker({ conn, source, verb, onCancel, onPick, onError }: Props) {
  const home = parentPath(source.path);
  const [dir, setDir] = useState(home);
  // Tagged with the folder it was loaded for (see Browser).
  const [listing, setListing] = useState<{ dir: string; folders: Entry[] } | null>(null);
  const folders = listing?.dir === dir ? listing.folders : null;

  useEffect(() => {
    let current = true;
    listDir(conn, dir)
      .then((r) => {
        // A folder can't go inside itself, so don't offer it as a way in.
        const folders = r.entries.filter((e) => e.is_dir && e.path !== source.path);
        if (current) setListing({ dir, folders });
      })
      .catch((e) => {
        if (!current) return;
        setListing({ dir, folders: [] });
        onError(e);
      });
    return () => {
      current = false;
    };
  }, [conn, dir, source.path, onError]);

  const samePlace = dir === home;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onCancel} hitSlop={10}>
          <Text style={{ color: colors.muted, fontSize: 16 }}>Cancel</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {verb} “{source.name}”
        </Text>
      </View>

      <Text style={styles.where} numberOfLines={2}>
        To: <Text style={{ color: colors.fg }}>/{dir}</Text>
      </Text>

      {folders === null ? (
        <ActivityIndicator color={colors.link} style={{ flex: 1 }} />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={folders}
          keyExtractor={(e) => e.path}
          ListHeaderComponent={
            dir ? (
              <Pressable onPress={() => setDir(parentPath(dir))} style={styles.row}>
                <Text style={styles.icon}>↩︎</Text>
                <Text style={{ color: colors.muted, fontSize: 16 }}>..</Text>
              </Pressable>
            ) : undefined
          }
          ListEmptyComponent={<Text style={styles.note}>No folders in here</Text>}
          renderItem={({ item }) => (
            <Pressable onPress={() => setDir(item.path)} style={styles.row}>
              <Text style={styles.icon}>📁</Text>
              <Text style={{ color: colors.fg, fontSize: 16, flex: 1 }} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 20 }}>›</Text>
            </Pressable>
          )}
        />
      )}

      <View style={styles.footer}>
        {samePlace && <Text style={styles.hint}>It is already in this folder — open another one.</Text>}
        <Pressable
          onPress={() => onPick(dir)}
          disabled={samePlace}
          style={[styles.button, samePlace && { opacity: 0.4 }]}>
          <Text style={styles.buttonText}>{verb} here</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  title: { color: colors.fg, fontSize: 17, fontWeight: '700', flex: 1 },
  where: { color: colors.muted, paddingHorizontal: 14, paddingVertical: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
  note: { color: colors.muted, textAlign: 'center', padding: 28 },
  footer: { padding: 14, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  hint: { color: colors.muted, fontSize: 12, textAlign: 'center', marginBottom: 8 },
  button: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  buttonText: { color: colors.accentFg, fontSize: 16, fontWeight: '600' },
});
