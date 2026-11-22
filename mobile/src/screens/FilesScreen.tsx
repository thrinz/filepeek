import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, StyleSheet, useWindowDimensions, View } from 'react-native';

import { AuthError, parentPath } from '../api';
import { Browser } from '../components/Browser';
import { PermLinks } from '../components/PermLinks';
import { Search } from '../components/Search';
import { Viewer, type OpenFile } from '../components/Viewer';
import type { Connection } from '../storage';
import { colors } from '../theme';

/** At or above this width the list and viewer sit side by side. */
const SPLIT_MIN_WIDTH = 700;

export default function FilesScreen({
  conn,
  onDisconnect,
  onAuthLost,
}: {
  conn: Connection;
  /** The user chose to leave: forget the saved connection. */
  onDisconnect: () => void;
  /** Silent re-login failed: back to Connect with the saved details filled in. */
  onAuthLost: () => void;
}) {
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_MIN_WIDTH;
  const [path, setPath] = useState('');
  const [file, setFile] = useState<OpenFile | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const onError = useCallback(
    (e: unknown) => {
      // api.ts already retried with the stored credential, so this is final.
      if (e instanceof AuthError) {
        onAuthLost();
        return;
      }
      Alert.alert('Something went wrong', e instanceof Error ? e.message : String(e));
    },
    [onAuthLost],
  );

  // True while the editor holds unsaved changes. Anything that would replace
  // or close the open file goes through `guarded` first.
  const openCount = useRef(0);
  const dirty = useRef(false);
  const setDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);
  const guarded = useCallback((action: () => void) => {
    if (!dirty.current) {
      action();
      return;
    }
    Alert.alert('Discard changes?', 'You have unsaved edits in the open file.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          dirty.current = false;
          action();
        },
      },
    ]);
  }, []);

  const openFile = useCallback(
    (p: string, name: string) =>
      guarded(() => {
        // A new key even for the same path, so a discarded editor closes.
        setFile({ key: ++openCount.current, path: p, name });
        setPath(parentPath(p)); // keeps the list on the file's folder (matters for perm links)
      }),
    [guarded],
  );

  // Keep the open file and current folder valid after a rename or delete.
  const itemChanged = useCallback((oldPath: string, newPath: string | null) => {
    const moved = (p: string) =>
      p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? newPath && newPath + p.slice(oldPath.length) : p;
    setFile((f) => {
      if (!f) return f;
      const p = moved(f.path);
      if (p === f.path) return f;
      if (p === null) {
        dirty.current = false; // the file is gone, and its editor with it
        return null;
      }
      return { ...f, path: p, name: p.split('/').pop() ?? f.name };
    });
    setPath((p) => moved(p) ?? parentPath(oldPath));
  }, []);

  // Android back: close the full-screen viewer, then walk up the folders.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (file && !split) {
        guarded(() => setFile(null));
        return true;
      }
      if (path) {
        setPath(parentPath(path));
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [file, split, path, guarded]);

  const viewerCoversList = !split && file !== null;

  return (
    <View style={styles.main}>
      {/* The list stays mounted under the phone viewer so it keeps its scroll position. */}
      <View style={[split ? styles.left : styles.fill, viewerCoversList && styles.hidden]}>
        <Browser
          conn={conn}
          path={path}
          onNavigate={setPath}
          selectedPath={file?.path ?? null}
          onOpenFile={openFile}
          onShowPermLinks={() => setShowLinks(true)}
          onShowSearch={() => setShowSearch(true)}
          onItemChanged={itemChanged}
          onLogout={onDisconnect}
          onError={onError}
        />
      </View>
      {(split || file) && (
        <View style={styles.fill}>
          <Viewer
            conn={conn}
            file={file}
            onClose={() => setFile(null)}
            showBack={!split}
            onDirtyChange={setDirty}
            onError={onError}
          />
        </View>
      )}
      <Search
        conn={conn}
        visible={showSearch}
        onClose={() => setShowSearch(false)}
        onOpen={openFile}
        onError={onError}
      />
      <PermLinks
        conn={conn}
        visible={showLinks}
        onClose={() => setShowLinks(false)}
        onOpen={openFile}
        onError={onError}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  main: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg },
  fill: { flex: 1 },
  left: { width: 340, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  hidden: { display: 'none' },
});
