import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  addBookmark,
  ApiError,
  authHeaders,
  Bookmark,
  cancelZip,
  copyItem,
  createItem,
  deleteBookmark,
  deleteItem,
  Entry,
  formatSize,
  joinPath,
  listBookmarks,
  listDir,
  moveItem,
  parentPath,
  PickedFile,
  renameItem,
  startZip,
  uploadFile,
  zipDownloadUrl,
  zipStatus,
} from '../api';
import { Bookmarks } from './Bookmarks';
import { FolderPicker } from './FolderPicker';
import { NameDialog } from './NameDialog';
import type { Connection } from '../storage';
import { colors } from '../theme';

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.action}>
      <Text style={{ color: colors.link, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

/** How often to ask the server how far a folder zip has got. */
const ZIP_POLL_MS = 700;

/** Ask whether to replace an existing item; resolves true for "Replace". */
const confirmOverwrite = (name: string, detail = '') =>
  new Promise<boolean>((resolve) =>
    Alert.alert('Already exists', `Replace “${name}”?${detail}`, [
      { text: 'Skip', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Replace', style: 'destructive', onPress: () => resolve(true) },
    ]),
  );

/** The left pane: one folder's contents, with create/upload actions. */
export function Browser({
  conn,
  path,
  onNavigate,
  selectedPath,
  onOpenFile,
  onShowPermLinks,
  onShowSearch,
  onItemChanged,
  onLogout,
  onError,
}: {
  conn: Connection;
  path: string;
  onNavigate: (path: string) => void;
  selectedPath: string | null;
  onOpenFile: (path: string, name: string) => void;
  onShowPermLinks: () => void;
  onShowSearch: () => void;
  /** A file or folder was renamed (newPath) or deleted (null). */
  onItemChanged: (oldPath: string, newPath: string | null) => void;
  onLogout: () => void;
  onError: (e: unknown) => void;
}) {
  // Tagged with the folder it was loaded for, so a stale list is never shown
  // under a new path while that path is still loading.
  const [listing, setListing] = useState<{ path: string; entries: Entry[] } | null>(null);
  const entries = listing?.path === path ? listing.entries : null;
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState<null | 'file' | 'folder'>(null);
  const [renaming, setRenaming] = useState<Entry | null>(null);
  const [transfer, setTransfer] = useState<{ kind: 'move' | 'copy'; entry: Entry } | null>(null);
  const [status, setStatus] = useState('');
  // Set while a folder zip is being built, so the banner can offer Cancel.
  const [zipping, setZipping] = useState(false);
  const zipCancelled = useRef(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const bookmarked = bookmarks.some((b) => b.path === path);

  const fetchBookmarks = useCallback(async () => {
    try {
      return (await listBookmarks(conn)).bookmarks;
    } catch (e) {
      onError(e);
      return [];
    }
  }, [conn, onError]);

  useEffect(() => {
    let mounted = true;
    fetchBookmarks().then((b) => {
      if (mounted) setBookmarks(b);
    });
    return () => {
      mounted = false;
    };
  }, [fetchBookmarks]);

  const toggleBookmark = async () => {
    try {
      if (bookmarked) await deleteBookmark(conn, path);
      else await addBookmark(conn, path);
      setBookmarks(await fetchBookmarks());
    } catch (e) {
      onError(e);
    }
  };

  const removeBookmark = async (b: Bookmark) => {
    try {
      await deleteBookmark(conn, b.path);
      setBookmarks(await fetchBookmarks());
    } catch (e) {
      onError(e);
    }
  };

  const fetchListing = useCallback(async () => {
    try {
      return { path, entries: (await listDir(conn, path)).entries };
    } catch (e) {
      onError(e);
      return { path, entries: [] };
    }
  }, [conn, path, onError]);

  const load = async () => setListing(await fetchListing());

  useEffect(() => {
    let current = true; // ignore a slow response for a folder we've already left
    fetchListing().then((l) => {
      if (current) setListing(l);
    });
    return () => {
      current = false;
    };
  }, [fetchListing]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const create = async (name: string) => {
    const isDir = creating === 'folder';
    setCreating(null);
    try {
      const made = await createItem(conn, joinPath(path, name), isDir);
      await load();
      if (!isDir) onOpenFile(made.path, made.name);
    } catch (e) {
      onError(e);
    }
  };

  const rename = async (name: string) => {
    const entry = renaming;
    setRenaming(null);
    if (!entry) return;
    try {
      const renamed = await renameItem(conn, entry.path, name);
      onItemChanged(entry.path, renamed.path);
      await load();
      if (entry.is_dir) setBookmarks(await fetchBookmarks());
    } catch (e) {
      onError(e);
    }
  };

  const runTransfer = async (destDir: string) => {
    const job = transfer;
    setTransfer(null);
    if (!job) return;
    const { kind, entry } = job;
    const run = kind === 'move' ? moveItem : copyItem;
    try {
      let result: Entry;
      try {
        result = await run(conn, entry.path, destDir);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        // Replacing removes what is there first — for a folder, all of it.
        const detail = entry.is_dir ? '\n\nThe existing folder and everything in it will be deleted first.' : '';
        if (!(await confirmOverwrite(entry.name, detail))) return;
        result = await run(conn, entry.path, destDir, true);
      }
      if (kind === 'move') onItemChanged(entry.path, result.path);
      await load();
      if (entry.is_dir) setBookmarks(await fetchBookmarks());
    } catch (e) {
      onError(e);
    }
  };

  /** Zip a folder on the server, then hand the zip to the share sheet. */
  const downloadZip = async (folderPath: string, label: string) => {
    if (zipping) {
      Alert.alert('Already zipping', 'Wait for the current folder download to finish, or cancel it.');
      return;
    }
    zipCancelled.current = false;
    setZipping(true);
    setStatus(`Zipping ${label}…`);
    let job = '';
    try {
      job = (await startZip(conn, folderPath)).job;
      let state = await zipStatus(conn, job);
      while (state.status === 'running' && !zipCancelled.current) {
        setStatus(`Zipping ${label}… ${state.done}/${state.total} files`);
        await new Promise((r) => setTimeout(r, ZIP_POLL_MS));
        state = await zipStatus(conn, job);
      }
      if (zipCancelled.current || state.status === 'cancelled') {
        await cancelZip(conn, job);
        return;
      }
      if (state.status !== 'done') throw new Error(state.error || 'The server could not zip this folder.');

      setStatus(`Downloading ${state.name}…`);
      const saved = await File.downloadFileAsync(zipDownloadUrl(conn, job), new File(Paths.cache, state.name), {
        headers: authHeaders(conn),
        idempotent: true,
      });
      job = ''; // the server drops the job once it has been downloaded
      setStatus('');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(saved.uri, { dialogTitle: state.name, mimeType: 'application/zip' });
      } else {
        Alert.alert('Downloaded', saved.uri);
      }
    } catch (e) {
      // Don't leave a half-built or unclaimed zip on the server.
      if (job) cancelZip(conn, job).catch(() => {});
      onError(e);
    } finally {
      setStatus('');
      setZipping(false);
    }
  };

  /** The less-used folder actions, kept off the button row to save space. */
  const moreMenu = () =>
    Alert.alert(path ? `/${path}` : 'Home', undefined, [
      { text: 'Paste image', onPress: pasteImage },
      {
        text: 'Download folder as zip',
        onPress: () => downloadZip(path, path ? path.split('/').pop()! : 'everything'),
      },
      { text: `Bookmarks${bookmarks.length ? ` (${bookmarks.length})` : ''}`, onPress: () => setShowBookmarks(true) },
      { text: 'Perm links', onPress: onShowPermLinks },
      { text: 'Cancel', style: 'cancel' },
    ]);

  const confirmDelete = (entry: Entry) =>
    Alert.alert(
      entry.is_dir ? 'Delete folder?' : 'Delete file?',
      entry.is_dir
        ? `“${entry.name}” and everything inside it will be permanently deleted.`
        : `“${entry.name}” will be permanently deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteItem(conn, entry.path);
              onItemChanged(entry.path, null);
              await load();
              if (entry.is_dir) setBookmarks(await fetchBookmarks()); // the server drops bookmarks inside it
            } catch (e) {
              onError(e);
            }
          },
        },
      ],
    );

  const itemMenu = (entry: Entry) =>
    Alert.alert(entry.name, undefined, [
      { text: 'Rename', onPress: () => setRenaming(entry) },
      { text: 'Move to…', onPress: () => setTransfer({ kind: 'move', entry }) },
      { text: 'Copy to…', onPress: () => setTransfer({ kind: 'copy', entry }) },
      ...(entry.is_dir ? [{ text: 'Download as zip', onPress: () => downloadZip(entry.path, entry.name) }] : []),
      { text: 'Delete', style: 'destructive', onPress: () => confirmDelete(entry) },
      { text: 'Cancel', style: 'cancel' },
    ]);

  /** Upload photos or videos chosen from the phone's photo library. */
  const uploadPhotos = async () => {
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        quality: 1, // send the original, not a recompressed copy
      });
      if (picked.canceled) return;
      await uploadAll(
        picked.assets.map((a) => ({
          uri: a.uri,
          name: a.fileName || a.uri.split('/').pop() || 'photo.jpg',
          mimeType: a.mimeType,
        })),
      );
    } catch (e) {
      onError(e);
    }
  };

  /** The Files picker shows iCloud Drive / on-device files, not the photo library, so offer both. */
  const uploadMenu = () =>
    Alert.alert('Upload', `To ${path ? `/${path}` : 'Home'}`, [
      { text: 'Photo library', onPress: uploadPhotos },
      { text: 'Files', onPress: upload },
      { text: 'Cancel', style: 'cancel' },
    ]);

  const upload = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (picked.canceled) return;
      await uploadAll(picked.assets);
    } catch (e) {
      onError(e);
    }
  };

  /** Upload the image on the clipboard (a copied photo or screenshot) into this folder. */
  const pasteImage = async () => {
    try {
      const image = (await Clipboard.hasImageAsync()) ? await Clipboard.getImageAsync({ format: 'png' }) : null;
      if (!image) {
        Alert.alert('No image to paste', 'Copy a photo or screenshot first, then tap Paste image.');
        return;
      }
      // The clipboard hands over a data: URI; the upload needs a real file.
      const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');
      const name = `pasted-${stamp}.png`;
      const tmp = new File(Paths.cache, name);
      tmp.write(image.data.slice(image.data.indexOf(',') + 1), { encoding: 'base64' });
      try {
        await uploadAll([{ uri: tmp.uri, name, mimeType: 'image/png' }]);
      } finally {
        tmp.delete();
      }
    } catch (e) {
      onError(e);
    }
  };

  const uploadAll = async (files: PickedFile[]) => {
    try {
      let done = 0;
      for (const f of files) {
        setStatus(`Uploading ${f.name} (${done + 1}/${files.length})…`);
        try {
          await uploadFile(conn, path, f);
          done++;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            if (await confirmOverwrite(f.name)) {
              await uploadFile(conn, path, f, true);
              done++;
            }
          } else {
            throw e;
          }
        }
      }
      setStatus('');
      await load();
      if (done) Alert.alert('Upload complete', `${done} file${done === 1 ? '' : 's'} uploaded to /${path}`);
    } catch (e) {
      setStatus('');
      await load(); // some files may have gone through before the failure
      onError(e);
    }
  };

  const crumbs = path ? path.split('/') : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[styles.header, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.brand, { color: colors.fg }]}>filepeek</Text>
        <Text style={{ color: colors.muted, fontSize: 12, flex: 1, marginHorizontal: 10 }} numberOfLines={1}>
          {conn.base.replace(/^https?:\/\//, '')}
        </Text>
        <Pressable onPress={onLogout} hitSlop={10}>
          <Text style={{ color: colors.muted }}>Disconnect</Text>
        </Pressable>
      </View>

      <View style={styles.actions}>
        <Action label="+ File" onPress={() => setCreating('file')} />
        <Action label="+ Folder" onPress={() => setCreating('folder')} />
        <Action label="Upload" onPress={uploadMenu} />
        <Action label="Search" onPress={onShowSearch} />
        <Action label="More ▾" onPress={moreMenu} />
      </View>

      <View style={styles.crumbRow}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.crumbs} contentContainerStyle={styles.stripInner}>
        <Pressable onPress={() => onNavigate('')} hitSlop={6}>
          <Text style={{ color: crumbs.length ? colors.link : colors.fg, fontWeight: '600' }}>Home</Text>
        </Pressable>
        {crumbs.map((name, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Pressable key={i} onPress={() => onNavigate(crumbs.slice(0, i + 1).join('/'))} disabled={last} hitSlop={6}>
              <Text style={{ color: last ? colors.fg : colors.link, fontWeight: '600' }}>
                <Text style={{ color: colors.muted }}> / </Text>
                {name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
        <Pressable
          onPress={toggleBookmark}
          hitSlop={8}
          style={styles.star}
          accessibilityLabel={bookmarked ? 'Remove this folder from bookmarks' : 'Bookmark this folder'}>
          <Text style={{ fontSize: 20, color: bookmarked ? colors.star : colors.muted }}>{bookmarked ? '★' : '☆'}</Text>
        </Pressable>
      </View>

      {status ? (
        <View style={[styles.status, { backgroundColor: colors.selected }]}>
          <ActivityIndicator color={colors.link} size="small" />
          <Text style={{ color: colors.fg, flex: 1 }} numberOfLines={1}>
            {status}
          </Text>
          {zipping && (
            <Pressable
              onPress={() => {
                zipCancelled.current = true;
                setStatus('Cancelling…');
              }}
              hitSlop={8}>
              <Text style={{ color: colors.link }}>Cancel</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {entries === null ? (
        <ActivityIndicator color={colors.link} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.path}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          ListHeaderComponent={
            path ? (
              <Pressable onPress={() => onNavigate(parentPath(path))} style={[styles.row, { borderColor: colors.border }]}>
                <Text style={styles.icon}>↩︎</Text>
                <Text style={{ color: colors.muted, fontSize: 16 }}>..</Text>
              </Pressable>
            ) : undefined
          }
          ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.muted }]}>This folder is empty</Text>}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => (item.is_dir ? onNavigate(item.path) : onOpenFile(item.path, item.name))}
              onLongPress={() => itemMenu(item)}
              style={[
                styles.row,
                { borderColor: colors.border },
                item.path === selectedPath && { backgroundColor: colors.selected },
              ]}>
              <Text style={styles.icon}>{item.is_dir ? '📁' : '📄'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.fg, fontSize: 16 }} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 12 }}>
                  {item.is_dir ? 'Folder' : formatSize(item.size)} · {item.modified.slice(0, 16).replace('T', ' ')}
                </Text>
              </View>
              <Pressable
                onPress={() => itemMenu(item)}
                hitSlop={10}
                style={styles.more}
                accessibilityLabel={`Actions for ${item.name}`}>
                <Text style={{ color: colors.muted, fontSize: 20 }}>⋯</Text>
              </Pressable>
            </Pressable>
          )}
        />
      )}

      <FolderPicker
        conn={conn}
        source={transfer?.entry ?? null}
        verb={transfer?.kind === 'copy' ? 'Copy' : 'Move'}
        onCancel={() => setTransfer(null)}
        onPick={runTransfer}
        onError={onError}
      />

      <Bookmarks
        visible={showBookmarks}
        bookmarks={bookmarks}
        onClose={() => setShowBookmarks(false)}
        onOpen={(b) => {
          setShowBookmarks(false);
          onNavigate(b.path);
        }}
        onRemove={removeBookmark}
      />

      <NameDialog
        visible={creating !== null}
        title={creating === 'folder' ? 'New folder' : 'New file'}
        placeholder={creating === 'folder' ? 'Folder name' : 'notes.md'}
        onCancel={() => setCreating(null)}
        onSubmit={create}
      />
      <NameDialog
        visible={renaming !== null}
        title={renaming?.is_dir ? 'Rename folder' : 'Rename file'}
        placeholder="New name"
        initial={renaming?.name}
        submitLabel="Rename"
        onCancel={() => setRenaming(null)}
        onSubmit={rename}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    minHeight: 46,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brand: { fontSize: 18, fontWeight: '700' },
  // Plain wrapping row: a horizontal ScrollView here got squeezed by the list
  // below it and clipped the buttons.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  crumbRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  crumbs: { flex: 1 },
  more: { paddingLeft: 12, paddingVertical: 6 },
  star: { paddingHorizontal: 14, paddingVertical: 4 },
  stripInner: { paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', gap: 8 },
  action: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
  emptyText: { textAlign: 'center', padding: 32 },
});
