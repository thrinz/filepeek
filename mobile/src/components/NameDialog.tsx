import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from '../theme';

type Props = {
  title: string;
  placeholder: string;
  /** Starting text (rename). */
  initial?: string;
  /** Label of the confirm button. */
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
};

/** Cross-platform replacement for Alert.prompt (which is iOS-only). */
export function NameDialog({ visible, ...props }: Props & { visible: boolean }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={props.onCancel}>
      {/* Mounted per opening, so the field starts fresh each time. */}
      {visible && <NameForm {...props} />}
    </Modal>
  );
}

function NameForm({ title, placeholder, initial = '', submitLabel = 'Create', onCancel, onSubmit }: Props) {
  const [name, setName] = useState(initial);

  const trimmed = name.trim();
  const valid =
    trimmed.length > 0 && !/[/\\]/.test(trimmed) && trimmed !== '.' && trimmed !== '..' && trimmed !== initial;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
      <View style={[styles.box, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.fg }]}>{title}</Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.fg, backgroundColor: colors.bg }]}
          value={name}
          onChangeText={setName}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => valid && onSubmit(trimmed)}
        />
        <View style={styles.row}>
          <Pressable onPress={onCancel} style={styles.btn}>
            <Text style={{ color: colors.muted, fontSize: 16 }}>Cancel</Text>
          </Pressable>
          <Pressable onPress={() => onSubmit(trimmed)} disabled={!valid} style={styles.btn}>
            <Text style={{ color: colors.link, fontSize: 16, fontWeight: '600', opacity: valid ? 1 : 0.4 }}>
              {submitLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 },
  box: { width: '100%', maxWidth: 400, alignSelf: 'center', borderWidth: 1, borderRadius: 12, padding: 18 },
  title: { fontSize: 17, fontWeight: '600', marginBottom: 12 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 14, gap: 8 },
  btn: { paddingHorizontal: 12, paddingVertical: 8 },
});
