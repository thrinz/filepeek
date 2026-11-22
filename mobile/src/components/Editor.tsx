import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { saveFile } from '../api';
import type { Connection } from '../storage';
import { colors } from '../theme';

/** Plain-text editor for one file. Mounted only while editing. */
export function Editor({
  conn,
  path,
  name,
  initial,
  onDirtyChange,
  onDone,
  onError,
}: {
  conn: Connection;
  path: string;
  name: string;
  initial: string;
  /** Lets the screen warn before unsaved edits are thrown away. */
  onDirtyChange: (dirty: boolean) => void;
  /** Leave the editor; `saved` says whether the file changed on the server. */
  onDone: (saved: boolean) => void;
  onError: (e: unknown) => void;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = text !== initial;

  const change = (next: string) => {
    setText(next);
    onDirtyChange(next !== initial);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveFile(conn, path, text);
      onDirtyChange(false);
      onDone(true);
    } catch (e) {
      setSaving(false);
      onError(e);
    }
  };

  const cancel = () => {
    if (!dirty) {
      onDone(false);
      return;
    }
    Alert.alert('Discard changes?', `Your edits to “${name}” will be lost.`, [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          onDirtyChange(false);
          onDone(false);
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.bar}>
        <Pressable onPress={cancel} disabled={saving} hitSlop={10} style={styles.barBtn}>
          <Text style={{ color: colors.muted, fontSize: 16 }}>Cancel</Text>
        </Pressable>
        <Text style={styles.name} numberOfLines={1}>
          {dirty ? '● ' : ''}
          {name}
        </Text>
        <Pressable onPress={save} disabled={!dirty || saving} hitSlop={10} style={styles.barBtn}>
          {saving ? (
            <ActivityIndicator color={colors.link} size="small" />
          ) : (
            <Text style={{ color: colors.link, fontSize: 16, fontWeight: '600', opacity: dirty ? 1 : 0.4 }}>Save</Text>
          )}
        </Pressable>
      </View>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={change}
        multiline
        editable={!saving}
        // Source files must come back exactly as typed.
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        smartInsertDelete={false}
        textAlignVertical="top"
        scrollEnabled
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    minHeight: 46,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  barBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  name: { flex: 1, color: colors.fg, fontSize: 15, fontWeight: '600', textAlign: 'center', paddingHorizontal: 6 },
  input: {
    flex: 1,
    color: colors.fg,
    padding: 12,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
