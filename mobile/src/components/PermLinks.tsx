import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { deletePermLink, listPermLinks, PermLink, permLinkUrl } from '../api';
import type { Connection } from '../storage';
import { colors } from '../theme';

type Props = {
  conn: Connection;
  onClose: () => void;
  onOpen: (path: string, name: string) => void;
  onError: (e: unknown) => void;
};

export function PermLinks({ visible, ...props }: Props & { visible: boolean }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={props.onClose}>
      {/* Mounted per opening, so the list is fetched fresh each time. */}
      {visible && <PermLinkList {...props} />}
    </Modal>
  );
}

function PermLinkList({ conn, onClose, onOpen, onError }: Props) {
  const [links, setLinks] = useState<PermLink[] | null>(null);

  const fetchLinks = useCallback(async () => {
    try {
      return (await listPermLinks(conn)).permlinks;
    } catch (e) {
      onError(e);
      return [];
    }
  }, [conn, onError]);

  const load = async () => setLinks(await fetchLinks());

  useEffect(() => {
    let mounted = true;
    fetchLinks().then((l) => {
      if (mounted) setLinks(l);
    });
    return () => {
      mounted = false;
    };
  }, [fetchLinks]);

  const copy = async (l: PermLink) => {
    await Clipboard.setStringAsync(permLinkUrl(conn, l.path));
    Alert.alert('Link copied', permLinkUrl(conn, l.path));
  };

  const remove = (l: PermLink) =>
    Alert.alert('Remove perm link?', l.path, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePermLink(conn, l.path);
            load();
          } catch (e) {
            onError(e);
          }
        },
      },
    ]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[styles.header, { borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.fg }]}>Perm links</Text>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={{ color: colors.link, fontSize: 16 }}>Done</Text>
        </Pressable>
      </View>
      {links === null ? (
        <ActivityIndicator color={colors.link} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={links}
          keyExtractor={(l) => l.path}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.muted }]}>
              No perm links yet. Open an HTML or Markdown file and tap “Perm link”.
            </Text>
          }
          renderItem={({ item }) => (
            <View style={[styles.row, { borderColor: colors.border }]}>
              <Pressable
                style={{ flex: 1 }}
                onPress={() => {
                  onClose();
                  onOpen(item.path, item.name);
                }}>
                <Text style={{ color: colors.fg, fontSize: 16 }} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>
                  {item.path}
                </Text>
              </Pressable>
              <Pressable onPress={() => copy(item)} hitSlop={6} style={styles.action}>
                <Text style={{ color: colors.link }}>Copy</Text>
              </Pressable>
              <Pressable onPress={() => remove(item)} hitSlop={6} style={styles.action}>
                <Text style={{ color: colors.danger }}>Remove</Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 18, fontWeight: '700' },
  empty: { textAlign: 'center', padding: 32, lineHeight: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  action: { paddingLeft: 14, paddingVertical: 6 },
});
