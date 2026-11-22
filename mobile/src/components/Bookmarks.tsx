import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Bookmark } from '../api';
import { colors } from '../theme';

/** Bookmarked folders (the same list the web UI shows). The Browser owns the data. */
export function Bookmarks({
  visible,
  bookmarks,
  onClose,
  onOpen,
  onRemove,
}: {
  visible: boolean;
  bookmarks: Bookmark[];
  onClose: () => void;
  onOpen: (b: Bookmark) => void;
  onRemove: (b: Bookmark) => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={styles.header}>
          <Text style={styles.title}>Bookmarks</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={{ color: colors.link, fontSize: 16 }}>Done</Text>
          </Pressable>
        </View>
        <FlatList
          data={bookmarks}
          keyExtractor={(b) => b.path}
          ListEmptyComponent={
            <Text style={styles.empty}>No bookmarked folders yet. Open a folder and tap the ☆ next to its path.</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Pressable style={{ flex: 1 }} onPress={() => onOpen(item)}>
                <Text style={{ color: colors.fg, fontSize: 16 }} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>
                  /{item.path}
                </Text>
              </Pressable>
              <Pressable onPress={() => onRemove(item)} hitSlop={6} style={styles.action}>
                <Text style={{ color: colors.danger }}>Remove</Text>
              </Pressable>
            </View>
          )}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  title: { color: colors.fg, fontSize: 18, fontWeight: '700' },
  empty: { color: colors.muted, textAlign: 'center', padding: 32, lineHeight: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  action: { paddingLeft: 14, paddingVertical: 6 },
});
