import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  Archive,
  AlertTriangle,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderPlus,
  Heart,
  ImagePlus,
  Images,
  Info,
  Loader,
  LogOut,
  Maximize,
  Minimize,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
  Star,
  Trash2,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import "./styles.css";

type Role = "admin" | "user";
type View = "photos" | "favorites" | "albums" | "archive" | "trash" | "admin";

type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
};

type Storyboard = {
  interval: number;
  cols: number;
  rows: number;
  count: number;
  tileWidth: number;
  tileHeight: number;
};

type Asset = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  takenAt: string;
  createdAt: string;
  favorite: boolean;
  archived: boolean;
  trashed: boolean;
  inSharedAlbum: boolean;
  mediaType: "image" | "video";
  status: "processing" | "ready" | "failed";
  durationMs: number | null;
  storyboard: Storyboard | null;
  urls: {
    thumb: string;
    preview: string;
    original: string | null;
    video: string | null;
    videoSd: string | null;
    hls: string | null;
    storyboard: string | null;
  };
};

type Album = {
  id: string;
  title: string;
  createdAt: string;
  assetCount: number;
  coverAssetId: string | null;
  shareToken: string | null;
  shareUrl: string | null;
};

const navItems = [
  { id: "photos", label: "Photos", icon: Images },
  { id: "favorites", label: "Favorites", icon: Heart },
  { id: "albums", label: "Albums", icon: Star },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "trash", label: "Trash", icon: Trash2 }
] as const;

const viewerInfoStorageKey = "sjodinPhotos.viewer.showInfo";
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;
const SWIPE_NAVIGATE_THRESHOLD = 60;
const SWIPE_CLOSE_THRESHOLD = 90;

type AppConfig = {
  appName: string;
  appShortName: string;
  attributionText: string;
  attributionUrl: string;
  maxUploadFileSizeMb: number;
  maxUploadVideoSizeMb: number;
};

const fallbackConfig: AppConfig = {
  appName: "Sjodin Photos",
  appShortName: "Photos",
  attributionText: "",
  attributionUrl: "",
  maxUploadFileSizeMb: 120,
  maxUploadVideoSizeMb: 2048
};

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const shareToken = window.location.pathname.startsWith("/share/")
    ? window.location.pathname.split("/").filter(Boolean)[1]
    : null;

  useEffect(() => {
    if (shareToken) {
      setBooting(false);
      return;
    }
    api<{ user: User }>("/api/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setBooting(false));
  }, [shareToken]);

  useEffect(() => {
    api<AppConfig>("/api/config")
      .then((data) => {
        setConfig(data);
        document.title = data.appName;
      })
      .catch(() => setConfig(fallbackConfig));
  }, []);

  const appName = config?.appName ?? "";
  if (booting) return <Splash />;
  if (shareToken) {
    return <SharedAlbum appName={appName} attribution={config ?? fallbackConfig} token={shareToken} />;
  }
  if (!user) return <Login appName={appName} onLogin={setUser} />;
  return (
    <PhotosApp
      appName={appName}
      user={user}
      onLogout={() => setUser(null)}
      maxImageMb={config?.maxUploadFileSizeMb ?? fallbackConfig.maxUploadFileSizeMb}
      maxVideoMb={config?.maxUploadVideoSizeMb ?? fallbackConfig.maxUploadVideoSizeMb}
    />
  );
}

function PhotosApp({ appName, user, onLogout, maxImageMb, maxVideoMb }: {
  appName: string;
  user: User;
  onLogout: () => void;
  maxImageMb: number;
  maxVideoMb: number;
}) {
  const [view, setView] = useState<View>("photos");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [activeAlbum, setActiveAlbum] = useState<Album | null>(null);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploadState, setUploadState] = useState<{ count: number; percent: number; processing: boolean } | null>(null);
  const [albumPickOpen, setAlbumPickOpen] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editAlbumOpen, setEditAlbumOpen] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmRequest | null>(null);
  const [linkPrompt, setLinkPrompt] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Session cache of each album's photos: opening a cached album renders
  // instantly and a background fetch revalidates it (stale-while-revalidate).
  const albumAssetsCache = useRef(new Map<string, Asset[]>());
  // Synced during render so async loads can tell whether their response still
  // belongs to what the user is looking at.
  const activeAlbumIdRef = useRef<string | null>(null);
  activeAlbumIdRef.current = activeAlbum?.id ?? null;

  useEffect(() => {
    if (!message || busy) return;
    const id = setTimeout(() => setMessage(""), 3500);
    return () => clearTimeout(id);
  }, [message, busy]);

  // The viewer's "Add to album" list needs albums before the Albums tab is visited.
  useEffect(() => {
    void loadAlbums();
    // Landing back from the share-target service worker flow.
    const params = new URLSearchParams(window.location.search);
    if (params.has("shared")) {
      setMessage(params.get("shared") === "1" ? "Shared items added to your library" : "Could not add the shared items");
      window.history.replaceState(null, "", "/");
    }
  }, []);

  function confirmAction(request: ConfirmRequest) {
    setConfirmState(request);
  }

  // Browser/hardware back leaves an open album before leaving the app.
  useBackClose(Boolean(activeAlbum), () => setActiveAlbum(null));

  const visibleAssets = useMemo(() => {
    if (!search.trim()) return assets;
    const query = search.toLowerCase();
    return assets.filter((asset) =>
      asset.originalName.toLowerCase().includes(query) ||
      prettyDate(asset.takenAt).toLowerCase().includes(query)
    );
  }, [assets, search]);

  useEffect(() => {
    clearSelect();
    if (view === "admin") return;
    if (view === "albums") {
      loadAlbums();
      if (!activeAlbum) return;
      loadAlbumAssets(activeAlbum.id);
      return;
    }
    setActiveAlbum(null);
    loadAssets(view);
  }, [view, activeAlbum?.id]);

  // While any visible video is still transcoding, quietly re-fetch so it flips
  // from the "Processing…" badge to a playable tile without a manual refresh.
  const hasProcessing = assets.some((asset) => asset.status === "processing");
  useEffect(() => {
    if (!hasProcessing) return;
    const interval = setInterval(() => void refreshForProcessing(), 5000);
    return () => clearInterval(interval);
  }, [hasProcessing, view]);

  async function loadAssets(nextView = view) {
    setBusy(true);
    try {
      const data = await api<{ assets: Asset[] }>(`/api/assets?view=${nextView}&q=${encodeURIComponent(search)}`);
      // A slow response must not clobber an album the user has since opened.
      if (!activeAlbumIdRef.current) setAssets(data.assets);
    } finally {
      setBusy(false);
    }
  }

  async function loadAlbums() {
    const data = await api<{ albums: Album[] }>("/api/albums");
    setAlbums(data.albums);
  }

  async function loadAlbumAssets(albumId: string) {
    const cached = albumAssetsCache.current.get(albumId);
    if (cached) {
      // Render the cached contents instantly; the fetch below revalidates.
      setAssets(cached);
    } else {
      // Never show the previous view's photos while the album loads.
      setAssets([]);
      setBusy(true);
    }
    try {
      const data = await api<{ assets: Asset[] }>(`/api/albums/${albumId}/assets`);
      albumAssetsCache.current.set(albumId, data.assets);
      if (activeAlbumIdRef.current === albumId) setAssets(data.assets);
    } finally {
      if (!cached) setBusy(false);
    }
  }

  /** Silent refetch (no busy spinner) used to poll transcoding videos to ready. */
  async function refreshForProcessing() {
    try {
      const albumId = activeAlbumIdRef.current;
      if (albumId) {
        const data = await api<{ assets: Asset[] }>(`/api/albums/${albumId}/assets`);
        albumAssetsCache.current.set(albumId, data.assets);
        if (activeAlbumIdRef.current === albumId) setAssets(data.assets);
      } else {
        const data = await api<{ assets: Asset[] }>(`/api/assets?view=${view}&q=${encodeURIComponent(search)}`);
        if (!activeAlbumIdRef.current) setAssets(data.assets);
      }
    } catch {
      // Ignore transient poll failures; the next tick retries.
    }
  }

  /** Edits the visible assets and keeps the open album's cache in sync. */
  function patchAssets(updater: (current: Asset[]) => Asset[]) {
    setAssets((current) => {
      const next = updater(current);
      const albumId = activeAlbumIdRef.current;
      if (albumId) albumAssetsCache.current.set(albumId, next);
      return next;
    });
  }

  async function uploadPhotos(files: FileList | File[] | null, albumId = activeAlbum?.id) {
    if (!files?.length) return;
    // Reject oversized files before any upload starts: images and videos have
    // separate server-side caps, so check each file against its own limit.
    const maxImageBytes = maxImageMb * 1024 * 1024;
    const maxVideoBytes = maxVideoMb * 1024 * 1024;
    const tooBig: string[] = [];
    const list = Array.from(files).filter((file) => {
      const limit = file.type.startsWith("video/") ? maxVideoBytes : maxImageBytes;
      if (file.size > limit) {
        tooBig.push(file.name);
        return false;
      }
      return true;
    });
    if (!list.length) {
      setMessage(tooBig.length
        ? `Too large to upload — images must be under ${formatMb(maxImageMb)}, videos under ${formatMb(maxVideoMb)}.`
        : "Nothing to upload.");
      return;
    }
    const batches = batchForUpload(list);
    const totalBytes = list.reduce((sum, file) => sum + file.size, 0) || 1;
    const endpoint = albumId ? `/api/albums/${albumId}/upload` : "/api/assets";
    let sentBytes = 0;
    let added = 0;
    let skipped = 0;
    let failed = 0;
    setBusy(true);
    setUploadState({ count: list.length, percent: 0, processing: false });
    try {
      for (const batch of batches) {
        const form = new FormData();
        batch.forEach((file) => form.append("photos", file));
        const result = await uploadWithProgress(endpoint, form, (loadedBytes) => {
          const percent = Math.min(100, Math.round(((sentBytes + loadedBytes) / totalBytes) * 100));
          setUploadState({ count: list.length, percent, processing: percent >= 100 });
        });
        sentBytes += batch.reduce((sum, file) => sum + file.size, 0);
        added += result.assets.length;
        skipped += result.duplicates?.length ?? 0;
        failed += result.errors.length;
      }
      const parts = [`Added ${added} item${added === 1 ? "" : "s"}`];
      if (skipped) parts.push(`skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}`);
      if (tooBig.length) parts.push(`${tooBig.length} too large`);
      if (failed) parts.push(`${failed} failed`);
      setMessage(parts.join(", "));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Upload failed.";
      const done = added + skipped;
      setMessage(done ? `Uploaded ${done} of ${list.length} items, then failed: ${reason}` : reason);
    } finally {
      // Refresh even after a mid-batch failure so already-uploaded photos show up.
      if (added || skipped) {
        if (albumId) {
          await loadAlbumAssets(albumId);
          await loadAlbums();
        } else {
          await loadAssets("photos");
          setView("photos");
        }
      }
      setBusy(false);
      setUploadState(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function mutateAsset(asset: Asset, patch: Partial<Pick<Asset, "favorite" | "archived" | "trashed">>) {
    const data = await api<{ asset: Asset }>(`/api/assets/${asset.id}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    const trashedAway = patch.trashed === true && view !== "trash";
    const archivedAway = patch.archived === true && view !== "archive";
    const untrashed = patch.trashed === false && view === "trash";
    const unarchived = patch.archived === false && view === "archive";
    const removesFromView = trashedAway || archivedAway || untrashed || unarchived;
    if (removesFromView && selected?.id === data.asset.id) {
      setSelected(null);
    } else {
      setSelected((current) => current?.id === data.asset.id ? data.asset : current);
    }
    patchAssets((current) => removesFromView
      ? current.filter((item) => item.id !== data.asset.id)
      : current.map((item) => item.id === data.asset.id ? data.asset : item));
    if (patch.trashed !== undefined) void loadAlbums();
  }

  async function deleteAsset(asset: Asset) {
    return new Promise<void>((resolve) => {
      confirmAction({
        title: "Delete item permanently?",
        body: "This removes the item and its files from disk. It cannot be undone."
          + (asset.inSharedAlbum ? " It will also disappear from any shared album it's in." : ""),
        confirmLabel: "Delete permanently",
        danger: true,
        onConfirm: async () => {
          await api(`/api/assets/${asset.id}`, { method: "DELETE" });
          setSelected(null);
          patchAssets((current) => current.filter((item) => item.id !== asset.id));
          void loadAlbums();
          resolve();
        },
        onCancel: () => resolve()
      });
    });
  }

  async function createAlbum(title: string, files?: FileList | File[] | null) {
    const data = await api<{ album: Album }>("/api/albums", {
      method: "POST",
      body: JSON.stringify({ title })
    });
    setAlbums((current) => [data.album, ...current]);
    setActiveAlbum(data.album);
    albumAssetsCache.current.set(data.album.id, []);
    if (files?.length) {
      await uploadPhotos(files, data.album.id);
    } else {
      setAssets([]);
    }
    return data.album;
  }

  async function addToAlbum(albumId: string, assetIds: string[] | string) {
    const ids = Array.isArray(assetIds) ? assetIds : [assetIds];
    await api(`/api/albums/${albumId}/assets`, {
      method: "POST",
      body: JSON.stringify({ assetIds: ids })
    });
    await loadAlbums();
    if (activeAlbum?.id === albumId) await loadAlbumAssets(albumId);
    else albumAssetsCache.current.delete(albumId);
  }

  async function openAddModal() {
    const data = await api<{ assets: Asset[] }>("/api/assets?view=photos");
    setLibraryAssets(data.assets);
    setAddModalOpen(true);
  }

  function emptyTrash() {
    const count = assets.length;
    confirmAction({
      title: "Empty trash?",
      body: `This permanently deletes ${count} item${count === 1 ? "" : "s"} from disk. It cannot be undone.`,
      confirmLabel: "Empty trash",
      danger: true,
      onConfirm: async () => {
        await api("/api/trash/empty", { method: "POST" });
        // Purged photos may sit in cached albums too.
        albumAssetsCache.current.clear();
        await loadAssets(view);
        void loadAlbums();
        setMessage("Trash emptied");
      }
    });
  }

  async function renameAlbum(title: string) {
    if (!activeAlbum) return;
    const data = await api<{ album: Album }>(`/api/albums/${activeAlbum.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title })
    });
    setAlbums((current) => current.map((item) => item.id === data.album.id ? { ...item, title: data.album.title } : item));
    setActiveAlbum((current) => current?.id === data.album.id ? { ...current, title: data.album.title } : current);
    setEditAlbumOpen(false);
    setMessage("Album renamed");
  }

  function requestDeleteAlbum(deleteAssets: boolean) {
    if (!activeAlbum) return;
    const album = activeAlbum;
    const count = album.assetCount;
    confirmAction({
      title: deleteAssets ? `Delete "${album.title}" and its items?` : `Delete "${album.title}"?`,
      body: deleteAssets
        ? `The album is removed and its ${count} item${count === 1 ? "" : "s"} move to the trash.`
        : "Only the album is removed — its items stay in your library.",
      confirmLabel: "Delete album",
      danger: true,
      onConfirm: async () => {
        await api(`/api/albums/${album.id}${deleteAssets ? "?deleteAssets=1" : ""}`, { method: "DELETE" });
        albumAssetsCache.current.delete(album.id);
        setEditAlbumOpen(false);
        setActiveAlbum(null);
        setAlbums((current) => current.filter((item) => item.id !== album.id));
        await loadAlbums();
        setMessage(deleteAssets ? "Album deleted, items moved to trash" : "Album deleted");
      }
    });
  }

  async function shareAlbum(album: Album) {
    const data = await api<{ album: Album }>(`/api/albums/${album.id}/share`, { method: "POST" });
    setAlbums((current) => current.map((item) => item.id === data.album.id ? data.album : item));
    setActiveAlbum((current) => current?.id === data.album.id ? data.album : current);
    const absoluteUrl = `${window.location.origin}${data.album.shareUrl}`;
    const copied = await navigator.clipboard?.writeText(absoluteUrl).then(() => true).catch(() => false);
    if (copied) {
      setMessage("Share link copied");
    } else {
      setLinkPrompt(absoluteUrl);
    }
  }

  async function unshareAlbum(album: Album) {
    return new Promise<void>((resolve) => {
      confirmAction({
        title: "Stop sharing this album?",
        body: "The public link stops working immediately. Your photos and the album itself are kept exactly as they are — nothing is deleted.",
        confirmLabel: "Stop sharing",
        onConfirm: async () => {
          const data = await api<{ album: Album }>(`/api/albums/${album.id}/share`, { method: "DELETE" });
          setAlbums((current) => current.map((item) => item.id === data.album.id ? data.album : item));
          setActiveAlbum((current) => current?.id === data.album.id ? data.album : current);
          setMessage("Sharing stopped");
          resolve();
        },
        onCancel: () => resolve()
      });
    });
  }

  async function setCoverPhoto(albumId: string, assetId: string) {
    const data = await api<{ album: Album }>(`/api/albums/${albumId}`, {
      method: "PATCH",
      body: JSON.stringify({ coverAssetId: assetId })
    });
    setAlbums((current) => current.map((item) => item.id === data.album.id ? data.album : item));
    setActiveAlbum((current) => current?.id === data.album.id ? data.album : current);
    setMessage("Cover updated");
  }

  function startSelect(id: string) {
    setSelectMode(true);
    setSelectedIds(new Set([id]));
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (next.size === 0) setSelectMode(false);
      return next;
    });
  }

  function clearSelect() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  async function bulkPatch(patch: Partial<Pick<Asset, "favorite" | "archived" | "trashed">>, note: string) {
    const ids = [...selectedIds];
    if (!ids.length) return;
    clearSelect();
    setBusy(true);
    try {
      await Promise.all(ids.map((id) =>
        api(`/api/assets/${id}`, { method: "PATCH", body: JSON.stringify(patch) })
      ));
      setMessage(note);
      if (activeAlbum) await loadAlbumAssets(activeAlbum.id);
      else await loadAssets(view);
      void loadAlbums();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function bulkDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const anyShared = assets.some((asset) => selectedIds.has(asset.id) && asset.inSharedAlbum);
    confirmAction({
      title: `Delete ${ids.length} item${ids.length === 1 ? "" : "s"} permanently?`,
      body: "This removes the items and their files from disk. It cannot be undone."
        + (anyShared ? " Any that are in a shared album will disappear from there too." : ""),
      confirmLabel: "Delete permanently",
      danger: true,
      onConfirm: async () => {
        clearSelect();
        await Promise.all(ids.map((id) => api(`/api/assets/${id}`, { method: "DELETE" })));
        // Permanently deleted photos may sit in cached albums too.
        albumAssetsCache.current.clear();
        await loadAssets(view);
        void loadAlbums();
      }
    });
  }

  async function bulkDownload() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setMessage("Preparing download");
    try {
      const response = await fetch("/api/assets/zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetIds: ids })
      });
      if (!response.ok) throw new Error("Download failed.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "photos.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage("");
      clearSelect();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Download failed.");
    }
  }

  async function bulkAddToAlbum(albumId: string) {
    const ids = [...selectedIds];
    setAlbumPickOpen(false);
    clearSelect();
    await addToAlbum(albumId, ids);
    const album = albums.find((item) => item.id === albumId);
    setMessage(album ? `Added to ${album.title}` : "Added to album");
  }

  async function bulkCreateAlbumAndAdd(title: string) {
    const ids = [...selectedIds];
    setAlbumPickOpen(false);
    clearSelect();
    const data = await api<{ album: Album }>("/api/albums", {
      method: "POST",
      body: JSON.stringify({ title })
    });
    setAlbums((current) => [data.album, ...current]);
    await addToAlbum(data.album.id, ids);
    setMessage(`Added to ${data.album.title}`);
  }

  function handleDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void uploadPhotos(event.dataTransfer.files, activeAlbum?.id);
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    onLogout();
  }

  const title = activeAlbum ? activeAlbum.title : view === "photos" ? "Photos" : labelFor(view);
  const showLibraryTools = view !== "admin" && !(view === "albums" && !activeAlbum);
  const uploadHint = `Up to ${formatMb(maxImageMb)} per image · ${formatMb(maxVideoMb)} per video`;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Camera size={22} /></div>
          <span>{appName}</span>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => (
            <button
              className={view === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => { setView(item.id); if (item.id === "albums") setActiveAlbum(null); }}
              type="button"
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </button>
          ))}
          {user.role === "admin" && (
            <button
              className={view === "admin" ? "nav-item active" : "nav-item"}
              onClick={() => setView("admin")}
              type="button"
            >
              <Shield size={20} />
              <span>Admin</span>
            </button>
          )}
        </nav>
        <div className="account-strip">
          <div>
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
          <button className="icon-button" onClick={logout} title="Log out" type="button">
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-heading">
            <div>
              {showLibraryTools && (
                <p className="eyebrow">{visibleAssets.length} item{visibleAssets.length === 1 ? "" : "s"}</p>
              )}
              <h1>{title}</h1>
            </div>
            <button className="icon-button mobile-only" onClick={logout} title="Log out" type="button">
              <LogOut size={20} />
            </button>
          </div>
          <div className="toolbar">
            {showLibraryTools && (
              <label className="search-field">
                <Search size={18} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !activeAlbum) void loadAssets(view);
                  }}
                  placeholder="Search"
                />
              </label>
            )}
            {showLibraryTools && visibleAssets.length > 0 && (
              <button
                className="secondary-button"
                onClick={() => selectMode ? clearSelect() : setSelectMode(true)}
                type="button"
              >
                {selectMode ? "Done" : "Select"}
              </button>
            )}
            {showLibraryTools && (
              <button className="primary-button" onClick={() => fileInput.current?.click()} title={uploadHint} type="button">
                <ImagePlus size={18} />
                <span>Upload</span>
              </button>
            )}
            <input
              ref={fileInput}
              className="hidden-input"
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={(event) => void uploadPhotos(event.target.files)}
            />
          </div>
        </header>

        {view === "trash" && (
          <div className="view-note trash-note">
            <p>Photos in the trash are deleted permanently after 30 days.</p>
            {assets.length > 0 && (
              <button className="danger-button" onClick={emptyTrash} type="button">
                <Trash2 size={16} />
                <span>Empty trash now</span>
              </button>
            )}
          </div>
        )}
        {view === "admin" ? (
          <AdminPanel currentUser={user} />
        ) : view === "albums" && !activeAlbum ? (
          <AlbumsView albums={albums} onCreate={createAlbum} onOpen={setActiveAlbum} onShare={shareAlbum} />
        ) : (
          <DropArea dragging={dragging} hint={uploadHint} onDragChange={setDragging} onDrop={handleDrop}>
            <LibraryView
              uploadHint={uploadHint}
              activeAlbum={activeAlbum}
              assets={visibleAssets}
              busy={busy}
              onAddExisting={openAddModal}
              onBack={() => setActiveAlbum(null)}
              onEditAlbum={() => setEditAlbumOpen(true)}
              onSelect={setSelected}
              onSetCover={activeAlbum ? setCoverPhoto : undefined}
              onShare={shareAlbum}
              onUnshare={unshareAlbum}
              onStartSelect={startSelect}
              onToggleSelect={toggleSelect}
              onUpload={() => fileInput.current?.click()}
              selectMode={selectMode}
              selectedIds={selectedIds}
            />
          </DropArea>
        )}
      </main>

      {message && <Overlay><div className="toast">{message}</div></Overlay>}

      {uploadState && (
        <Overlay>
          <div className="upload-progress" role="status">
            <div className="upload-progress-track">
              <div className="upload-progress-bar" style={{ width: `${uploadState.percent}%` }} />
            </div>
            <span>
              {uploadState.processing
                ? "Processing items…"
                : `Uploading ${uploadState.count} item${uploadState.count === 1 ? "" : "s"} — ${uploadState.percent}%`}
            </span>
          </div>
        </Overlay>
      )}

      {selectMode && (
        <Overlay>
          <div className="select-bar">
            <span className="select-count">{selectedIds.size} selected</span>
            <div className="select-bar-actions">
              {view === "trash" ? (
                <>
                  <button className="icon-button bar" disabled={!selectedIds.size} onClick={() => void bulkPatch({ trashed: false }, "Restored")} title="Restore" type="button"><RotateCcw size={20} /></button>
                  <button className="icon-button bar danger" disabled={!selectedIds.size} onClick={bulkDelete} title="Delete permanently" type="button"><Trash2 size={20} /></button>
                </>
              ) : (
                <>
                  <button className="icon-button bar" disabled={!selectedIds.size} onClick={() => setAlbumPickOpen(true)} title="Add to album" type="button"><FolderPlus size={20} /></button>
                  <button className="icon-button bar" disabled={!selectedIds.size} onClick={() => void bulkPatch({ favorite: true }, "Added to favorites")} title="Favorite" type="button"><Heart size={20} /></button>
                  {view === "archive" ? (
                    <button className="icon-button bar" disabled={!selectedIds.size} onClick={() => void bulkPatch({ archived: false }, "Unarchived")} title="Unarchive" type="button"><Archive size={20} /></button>
                  ) : (
                    <button className="icon-button bar" disabled={!selectedIds.size} onClick={() => void bulkPatch({ archived: true }, "Archived")} title="Archive" type="button"><Archive size={20} /></button>
                  )}
                  <button className="icon-button bar" disabled={!selectedIds.size} onClick={() => void bulkDownload()} title="Download" type="button"><Download size={20} /></button>
                  <button className="icon-button bar danger" disabled={!selectedIds.size} onClick={() => void bulkPatch({ trashed: true }, "Moved to trash")} title="Trash" type="button"><Trash2 size={20} /></button>
                </>
              )}
              <button className="icon-button bar" onClick={clearSelect} title="Done" type="button"><X size={20} /></button>
            </div>
          </div>
        </Overlay>
      )}

      {albumPickOpen && (
        <AlbumPickModal
          albums={albums}
          onClose={() => setAlbumPickOpen(false)}
          onCreateAndAdd={bulkCreateAlbumAndAdd}
          onPick={bulkAddToAlbum}
        />
      )}

      {addModalOpen && activeAlbum && (
        <AddExistingModal
          album={activeAlbum}
          albumAssets={assets}
          assets={libraryAssets}
          onAdd={(ids) => addToAlbum(activeAlbum.id, ids)}
          onClose={() => setAddModalOpen(false)}
        />
      )}

      {editAlbumOpen && activeAlbum && (
        <EditAlbumModal
          album={activeAlbum}
          onClose={() => setEditAlbumOpen(false)}
          onDelete={requestDeleteAlbum}
          onRename={renameAlbum}
        />
      )}

      {selected && (
        <Viewer
          activeAlbum={activeAlbum}
          albums={albums}
          asset={selected}
          assets={visibleAssets}
          onAddToAlbum={addToAlbum}
          onClose={() => setSelected(null)}
          onDelete={deleteAsset}
          onMutate={mutateAsset}
          onSelect={setSelected}
          onSetCover={setCoverPhoto}
        />
      )}

      {confirmState && (
        <ConfirmDialog request={confirmState} onClose={() => setConfirmState(null)} />
      )}
      {linkPrompt && (
        <LinkPrompt url={linkPrompt} onClose={() => setLinkPrompt(null)} />
      )}
    </div>
  );
}

/** Renders overlay content at document.body so position:fixed always means the
 *  real viewport — no ancestor (backdrop-filter, transform, …) can re-anchor it. */
function Overlay({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}

function useBodyScrollLock() {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
}

/**
 * Hardware/browser back closes the topmost open overlay (viewer, album,
 * modal) instead of leaving the app. Each open overlay pushes one history
 * entry; the global popstate handler closes the top of the stack, and
 * closing through the UI consumes the matching entry with history.back().
 */
const overlayStack: Array<() => void> = [];
let suppressPops = 0;
window.addEventListener("popstate", () => {
  if (suppressPops > 0) {
    suppressPops -= 1;
    return;
  }
  overlayStack.pop()?.();
});

function useBackClose(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const entry = () => closeRef.current();
    overlayStack.push(entry);
    history.pushState({ overlay: true }, "");
    return () => {
      const index = overlayStack.indexOf(entry);
      if (index !== -1) {
        // Closed through the UI — consume the history entry we pushed.
        overlayStack.splice(index, 1);
        suppressPops += 1;
        history.back();
      }
    };
  }, [open]);
}

function AlbumPickModal({
  albums,
  onClose,
  onCreateAndAdd,
  onPick
}: {
  albums: Album[];
  onClose: () => void;
  onCreateAndAdd: (title: string) => Promise<void>;
  onPick: (albumId: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  useBodyScrollLock();
  useBackClose(true, onClose);
  return (
    <Overlay>
      <div className="modal-backdrop" onClick={onClose}>
        <section className="modal confirm-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-head">
            <h2>Add to album</h2>
            <button className="icon-button" onClick={onClose} title="Close" type="button"><X size={18} /></button>
          </div>
          <div className="album-pick-list">
            {albums.map((album) => (
              <button key={album.id} onClick={() => void onPick(album.id)} type="button">
                <strong>{album.title}</strong>
                <span>{album.assetCount} item{album.assetCount === 1 ? "" : "s"}</span>
              </button>
            ))}
            {!albums.length && <p className="album-pick-empty">No albums yet — create one below.</p>}
          </div>
          <form
            className="album-pick-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim()) void onCreateAndAdd(title.trim());
            }}
          >
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="New album" />
            <button className="primary-button" disabled={!title.trim()} type="submit">Create</button>
          </form>
        </section>
      </div>
    </Overlay>
  );
}

type ConfirmRequest = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
};

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useBodyScrollLock();
  async function handleConfirm() {
    setBusy(true);
    setError("");
    try {
      await request.onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  function handleCancel() {
    if (busy) return;
    request.onCancel?.();
    onClose();
  }
  return (
    <Overlay>
      <div className="modal-backdrop" onClick={handleCancel}>
        <section className="modal confirm-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-head">
            <h2>{request.title}</h2>
          </div>
          {request.body && <p>{request.body}</p>}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button className="secondary-button" disabled={busy} onClick={handleCancel} type="button">{request.cancelLabel ?? "Cancel"}</button>
            <button
              className={request.danger ? "danger-button" : "primary-button"}
              disabled={busy}
              onClick={() => void handleConfirm()}
              type="button"
            >
              {busy ? "Working" : (request.confirmLabel ?? "Confirm")}
            </button>
          </div>
        </section>
      </div>
    </Overlay>
  );
}

function LinkPrompt({ url, onClose }: { url: string; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useBodyScrollLock();
  useEffect(() => { inputRef.current?.select(); }, []);
  return (
    <Overlay>
      <div className="modal-backdrop" onClick={onClose}>
        <section className="modal confirm-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-head">
            <h2>Share link</h2>
          </div>
          <p>Couldn't copy automatically. Select and copy the link below.</p>
          <input ref={inputRef} readOnly value={url} onFocus={(event) => event.target.select()} />
          <div className="modal-actions">
            <button className="primary-button" onClick={onClose} type="button">Done</button>
          </div>
        </section>
      </div>
    </Overlay>
  );
}

function Login({ appName, onLogin }: { appName: string; onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      onLogin(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand login-brand">
          <div className="brand-mark"><Camera size={24} /></div>
          <span>{appName}</span>
        </div>
        <h1>Welcome back</h1>
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" />
        </label>
        <label>
          Password
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button wide" disabled={busy} type="submit">
          <Sparkles size={18} />
          <span>{busy ? "Signing in" : "Sign in"}</span>
        </button>
      </form>
    </div>
  );
}

function SharedAlbum({
  appName,
  attribution,
  token
}: {
  appName: string;
  attribution: Pick<AppConfig, "attributionText" | "attributionUrl">;
  token: string;
}) {
  const [album, setAlbum] = useState<Album | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ album: Album; assets: Asset[] }>(`/api/share/${token}`)
      .then((data) => {
        setAlbum(data.album);
        setAssets(data.assets);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Shared album not found."));
  }, [token]);

  if (error) {
    return (
      <section className="shared-page">
        <div className="empty-state">
          <div className="empty-icon"><Images size={38} /></div>
          <h2>{error}</h2>
        </div>
      </section>
    );
  }

  if (!album) return <Splash />;

  return (
    <section className="shared-page">
      <header className="shared-header">
        <div className="brand">
          <div className="brand-mark"><Camera size={22} /></div>
          <span>{appName}</span>
        </div>
        <div>
          <p className="eyebrow">{assets.length} item{assets.length === 1 ? "" : "s"}</p>
          <h1>{album.title}</h1>
        </div>
      </header>
      {assets.length ? (
        <LibraryView
          activeAlbum={null}
          assets={assets}
          busy={false}
          onAddExisting={() => undefined}
          onBack={() => undefined}
          onSelect={setSelected}
          onShare={async () => undefined}
          onUpload={() => undefined}
        />
      ) : (
        <div className="empty-state">
          <div className="empty-icon"><Images size={38} /></div>
          <h2>No photos in this shared album</h2>
        </div>
      )}
      {attribution.attributionText && (
        <footer className="shared-footer">
          {attribution.attributionUrl ? (
            <a href={attribution.attributionUrl} rel="noreferrer">{attribution.attributionText}</a>
          ) : (
            <span>{attribution.attributionText}</span>
          )}
        </footer>
      )}
      {selected && (
        <SharedViewer asset={selected} assets={assets} onClose={() => setSelected(null)} onSelect={setSelected} />
      )}
    </section>
  );
}

/**
 * The image stage shared by both viewers. Owns keyboard navigation, touch
 * gestures (swipe left/right to navigate, swipe down to close), neighbour
 * preloading, and the top toolbar. Rendered in a portal so `fixed` always
 * anchors to the viewport.
 */
function ViewerStage({
  asset,
  previous,
  next,
  onClose,
  onSelect,
  actions,
  panel,
  infoOpen
}: {
  asset: Asset;
  previous: Asset | null;
  next: Asset | null;
  onClose: () => void;
  onSelect: (asset: Asset) => void;
  actions?: React.ReactNode;
  panel?: React.ReactNode;
  infoOpen?: boolean;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Track the loaded asset's id rather than a boolean: a cached preview can
  // fire onLoad before the asset-change effect runs, and a boolean reset
  // there would erase it and leave the blurred backdrop up forever.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const loaded = loadedId === asset.id;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const swipe = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const zoom = useRef({ scale: 1, tx: 0, ty: 0 });
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const justSwiped = useRef(false);
  // Video playback: the custom player handles its own gestures, so the
  // swipe/zoom logic below is skipped when the current asset is a playable video.
  const isVideo = asset.mediaType === "video" && asset.status === "ready" && Boolean(asset.urls.video);
  useBodyScrollLock();
  useBackClose(true, onClose);

  useEffect(() => {
    zoom.current = { scale: 1, tx: 0, ty: 0 };
    pinch.current = null;
    swipe.current = null;
    // If the preview came straight from cache, load may have fired before
    // this effect (or before React attached the listener) — catch up here.
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) setLoadedId(asset.id);
  }, [asset.id]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // While fullscreen, Escape only exits fullscreen — don't also close.
        if (!document.fullscreenElement) onClose();
        return;
      }
      // For videos the player owns the arrow keys (they seek, YouTube-style).
      if (isVideo) return;
      if (event.key === "ArrowLeft" && previous) onSelect(previous);
      if (event.key === "ArrowRight" && next) onSelect(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous, onClose, onSelect, isVideo]);

  useEffect(() => {
    for (const neighbour of [previous, next]) {
      if (neighbour) {
        const preload = new Image();
        preload.src = neighbour.urls.preview;
      }
    }
  }, [previous?.id, next?.id]);

  function applyZoom(animate = false) {
    const img = imgRef.current;
    if (!img) return;
    const { scale, tx, ty } = zoom.current;
    img.style.transition = animate ? "transform 180ms ease" : "none";
    img.style.transform = scale === 1 && !tx && !ty ? "" : `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function clampPan() {
    const img = imgRef.current;
    if (!img) return;
    const maxX = ((zoom.current.scale - 1) * img.clientWidth) / 2;
    const maxY = ((zoom.current.scale - 1) * img.clientHeight) / 2;
    zoom.current.tx = Math.min(maxX, Math.max(-maxX, zoom.current.tx));
    zoom.current.ty = Math.min(maxY, Math.max(-maxY, zoom.current.ty));
  }

  function toggleZoom(focusX: number, focusY: number) {
    const img = imgRef.current;
    if (!img) return;
    if (zoom.current.scale > 1) {
      zoom.current = { scale: 1, tx: 0, ty: 0 };
    } else {
      const rect = img.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const scale = 2.5;
      // Keep the tapped point stationary: with origin center, p maps to
      // c + (p - c) * s + t, so t = (p - c) * (1 - s) holds it in place.
      zoom.current = { scale, tx: (focusX - centerX) * (1 - scale), ty: (focusY - centerY) * (1 - scale) };
      clampPan();
    }
    applyZoom(true);
  }

  function handleDoubleTapCandidate(event: React.PointerEvent) {
    if (event.pointerType === "mouse") return;
    const now = Date.now();
    const last = lastTap.current;
    lastTap.current = { time: now, x: event.clientX, y: event.clientY };
    if (last && now - last.time < 300 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 40) {
      lastTap.current = null;
      justSwiped.current = true;
      toggleZoom(event.clientX, event.clientY);
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // Native video controls own all pointer interaction for videos.
    if (isVideo) return;
    // Pointer capture would redirect the eventual click away from toolbar
    // buttons, so gestures rely on bubbling instead — and never start on one.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.pointerType === "mouse" && zoom.current.scale === 1) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [first, second] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(first.x - second.x, first.y - second.y), scale: zoom.current.scale };
      swipe.current = null;
      applyZoom();
    } else if (pointers.current.size === 1 && zoom.current.scale === 1) {
      swipe.current = { x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const tracked = pointers.current.get(event.pointerId);
    if (!tracked) return;
    const previousX = tracked.x;
    const previousY = tracked.y;
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    if (pinch.current && pointers.current.size >= 2) {
      const [first, second] = [...pointers.current.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (!distance || !pinch.current.distance) return;
      const nextScale = Math.min(4, Math.max(1, (pinch.current.scale * distance) / pinch.current.distance));
      const ratio = nextScale / zoom.current.scale;
      zoom.current.scale = nextScale;
      zoom.current.tx *= ratio;
      zoom.current.ty *= ratio;
      clampPan();
      applyZoom();
      justSwiped.current = true;
      return;
    }

    if (zoom.current.scale > 1 && pointers.current.size === 1) {
      zoom.current.tx += event.clientX - previousX;
      zoom.current.ty += event.clientY - previousY;
      clampPan();
      applyZoom();
      justSwiped.current = true;
      return;
    }

    const current = swipe.current;
    const img = imgRef.current;
    if (!current || !img) return;
    current.dx = event.clientX - current.x;
    current.dy = event.clientY - current.y;
    img.style.transition = "none";
    if (Math.abs(current.dx) >= Math.abs(current.dy)) {
      img.style.transform = `translateX(${current.dx}px)`;
    } else if (current.dy > 0) {
      const scale = Math.max(0.8, 1 - current.dy / 1200);
      img.style.transform = `translateY(${current.dy}px) scale(${scale})`;
    }
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    const wasTracked = pointers.current.delete(event.pointerId);

    if (pinch.current) {
      if (pointers.current.size < 2) {
        pinch.current = null;
        if (zoom.current.scale < 1.05) {
          zoom.current = { scale: 1, tx: 0, ty: 0 };
          applyZoom(true);
        }
      }
      return;
    }

    if (zoom.current.scale > 1) {
      if (wasTracked && !justSwiped.current) handleDoubleTapCandidate(event);
      return;
    }

    const current = swipe.current;
    swipe.current = null;
    const img = imgRef.current;
    if (!current || !img) {
      if (wasTracked) handleDoubleTapCandidate(event);
      return;
    }
    justSwiped.current = Math.hypot(current.dx, current.dy) > 10;
    if (!justSwiped.current) handleDoubleTapCandidate(event);
    const horizontal = Math.abs(current.dx) >= Math.abs(current.dy);
    if (horizontal && current.dx <= -SWIPE_NAVIGATE_THRESHOLD && next) {
      onSelect(next);
      return;
    }
    if (horizontal && current.dx >= SWIPE_NAVIGATE_THRESHOLD && previous) {
      onSelect(previous);
      return;
    }
    if (!horizontal && current.dy >= SWIPE_CLOSE_THRESHOLD) {
      onClose();
      return;
    }
    img.style.transition = "transform 180ms ease";
    img.style.transform = "";
  }

  return (
    <Overlay>
      <div aria-modal="true" className={infoOpen ? "viewer info-open" : "viewer"} role="dialog">
        <div
          className={isVideo ? "viewer-stage is-video" : "viewer-stage"}
          onClick={(event) => {
            if (justSwiped.current) {
              justSwiped.current = false;
              return;
            }
            if (event.target === event.currentTarget) onClose();
          }}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerLeave={handlePointerEnd}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
        >
          <div className="viewer-topbar">
            <button className="icon-button light" onClick={onClose} title="Close" type="button"><X size={20} /></button>
            <div className="viewer-actions">
              {actions}
            </div>
          </div>
          {previous && (
            <button className="viewer-nav previous" onClick={() => onSelect(previous)} title="Previous" type="button">
              <ChevronLeft size={28} />
            </button>
          )}
          {isVideo ? (
            <VideoPlayer asset={asset} key={asset.id} />
          ) : (
            <>
              {!loaded && (
                <img alt="" aria-hidden className="viewer-backdrop" draggable={false} key={`backdrop-${asset.id}`} src={asset.urls.thumb} />
              )}
              <img
                alt={asset.originalName}
                className={loaded ? "viewer-image" : "viewer-image loading"}
                draggable={false}
                key={asset.id}
                onDoubleClick={(event) => toggleZoom(event.clientX, event.clientY)}
                onLoad={() => setLoadedId(asset.id)}
                ref={imgRef}
                src={asset.urls.preview}
              />
            </>
          )}
          {next && (
            <button className="viewer-nav next" onClick={() => onSelect(next)} title="Next" type="button">
              <ChevronRight size={28} />
            </button>
          )}
        </div>
        {panel}
      </div>
    </Overlay>
  );
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const CONTROLS_HIDE_MS = 2600;
const DOUBLE_TAP_MS = 300;
const playerPrefsKey = "sjodinPhotos.player";

function loadPlayerPrefs(): { volume: number; muted: boolean; rate: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(playerPrefsKey) ?? "{}") as Partial<{ volume: number; muted: boolean; rate: number }>;
    return {
      volume: typeof raw.volume === "number" ? Math.min(1, Math.max(0, raw.volume)) : 1,
      muted: Boolean(raw.muted),
      rate: typeof raw.rate === "number" && PLAYBACK_RATES.includes(raw.rate) ? raw.rate : 1
    };
  } catch {
    return { volume: 1, muted: false, rate: 1 };
  }
}

/**
 * Custom video player (YouTube/Google Photos style): adaptive HLS streaming
 * with automatic quality switching (hls.js, or Safari's native HLS), scrub bar
 * with storyboard thumbnail previews, playback speed and quality menus,
 * keyboard shortcuts, double-tap seeking on touch, and auto-hiding controls.
 * Falls back to the progressive MP4 renditions when HLS isn't available.
 * Remounted per asset (keyed on asset.id), so all state is per-video.
 */
function VideoPlayer({ asset }: { asset: Asset }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const hideTimer = useRef<number | null>(null);
  const singleTapTimer = useRef<number | null>(null);
  const lastTap = useRef<{ time: number; x: number } | null>(null);
  const lastPointerType = useRef<string>("mouse");
  const scrubbing = useRef(false);
  const scrubWasPlaying = useRef(false);
  // Playhead/play-state carried across quality-triggered source swaps.
  const resumeRef = useRef<{ time: number; playing: boolean } | null>(null);
  const prefs = useRef(loadPlayerPrefs());

  const [engine, setEngine] = useState<"hls" | "native" | "mp4">("mp4");
  // useMp4 forces the progressive renditions (no HLS asset yet, hls.js
  // unsupported, or the user picked an explicit rendition on native-HLS Safari).
  const [useMp4, setUseMp4] = useState(!asset.urls.hls);
  const [mp4Quality, setMp4Quality] = useState<"hd" | "sd">("hd");
  const [playing, setPlaying] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState((asset.durationMs ?? 0) / 1000);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(prefs.current.muted);
  const [volume, setVolume] = useState(prefs.current.volume);
  const [rate, setRate] = useState(prefs.current.rate);
  const [levels, setLevels] = useState<number[]>([]);
  const [manualLevel, setManualLevel] = useState(-1);
  const [autoHeight, setAutoHeight] = useState<number | null>(null);
  const [menu, setMenu] = useState<"none" | "speed" | "quality">("none");
  const [controlsOn, setControlsOn] = useState(true);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [skip, setSkip] = useState<{ side: "back" | "forward"; id: number } | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;

  const bumpControls = useCallback(() => {
    setControlsOn(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused && !scrubbing.current && menuRef.current === "none") setControlsOn(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  // Pick and attach the source. Reruns when the user forces a rendition; the
  // asset itself is fixed for the component's lifetime (keyed remount).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let hls: import("hls.js").default | null = null;
    const resume = resumeRef.current;
    resumeRef.current = null;

    video.addEventListener("loadedmetadata", function restore() {
      video.playbackRate = prefs.current.rate;
      if (resume?.time) video.currentTime = resume.time;
      if (!resume || resume.playing) void video.play().catch(() => undefined);
    }, { once: true });

    // If a streaming engine produces no data at all (a browser that claims
    // HLS/MSE support but never opens the stream, a dead hls.js chunk, …),
    // the play button would silently do nothing — drop to progressive MP4.
    let watchdog: number | undefined;
    function armStallWatchdog() {
      watchdog = window.setTimeout(() => {
        if (!cancelled && video!.readyState === 0 && video!.buffered.length === 0) setUseMp4(true);
      }, 6000);
    }

    async function setup() {
      const hlsUrl = asset.urls.hls;
      if (hlsUrl && !useMp4) {
        // hls.js (MSE) first: some browsers claim canPlayType("…mpegurl")
        // without reliably streaming it. Native HLS is the fallback for
        // browsers without MSE (iOS Safari), where it works properly.
        let HlsCtor: typeof import("hls.js").default | null = null;
        try {
          HlsCtor = (await import("hls.js")).default;
        } catch {
          HlsCtor = null;
        }
        if (cancelled) return;
        if (HlsCtor?.isSupported()) {
          hls = new HlsCtor({ capLevelToPlayerSize: true });
          hlsRef.current = hls;
          const recovered = { network: false, media: false };
          hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
            if (!cancelled && hls) setLevels(hls.levels.map((level) => level.height));
          });
          hls.on(HlsCtor.Events.LEVEL_SWITCHED, (_event, data) => {
            if (!cancelled && hls) setAutoHeight(hls.levels[data.level]?.height ?? null);
          });
          hls.on(HlsCtor.Events.ERROR, (_event, data) => {
            if (!data.fatal || cancelled) return;
            // One shot at recovery per error type, then drop to plain MP4.
            if (data.type === "networkError" && !recovered.network) {
              recovered.network = true;
              hls?.startLoad();
            } else if (data.type === "mediaError" && !recovered.media) {
              recovered.media = true;
              hls?.recoverMediaError();
            } else {
              setUseMp4(true);
            }
          });
          hls.loadSource(hlsUrl);
          hls.attachMedia(video!);
          setEngine("hls");
          armStallWatchdog();
          return;
        }
        if (video!.canPlayType("application/vnd.apple.mpegurl")) {
          setEngine("native");
          video!.src = hlsUrl;
          armStallWatchdog();
          return;
        }
      }
      setEngine("mp4");
      const src = (mp4Quality === "sd" && asset.urls.videoSd) || asset.urls.video;
      if (src) video!.src = src;
    }
    void setup();

    return () => {
      cancelled = true;
      if (watchdog) window.clearTimeout(watchdog);
      if (hls) hls.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useMp4, mp4Quality]);

  // Apply persisted prefs and wire up media element state.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = prefs.current.volume;
    v.muted = prefs.current.muted;
    v.defaultPlaybackRate = prefs.current.rate;
    v.playbackRate = prefs.current.rate;

    function readBuffered() {
      if (!v) return;
      const ranges = v.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges.start(i) <= v.currentTime && v.currentTime <= ranges.end(i)) {
          setBuffered(ranges.end(i));
          return;
        }
      }
      setBuffered(ranges.length ? ranges.end(ranges.length - 1) : 0);
    }
    const onTime = () => {
      if (!scrubbing.current && v) setTime(v.currentTime);
      readBuffered();
    };
    const onDuration = () => {
      if (v && Number.isFinite(v.duration)) setDuration(v.duration);
    };
    const onPlay = () => {
      setPlaying(true);
      setEnded(false);
      bumpControls();
    };
    const onPause = () => {
      setPlaying(false);
      setControlsOn(true);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
    const onVolume = () => {
      if (!v) return;
      setMuted(v.muted);
      setVolume(v.volume);
      prefs.current = { ...prefs.current, volume: v.volume, muted: v.muted };
      localStorage.setItem(playerPrefsKey, JSON.stringify(prefs.current));
    };
    const onRate = () => {
      if (v) setRate(v.playbackRate);
    };
    const onWaiting = () => setStalled(true);
    const onPlaying = () => setStalled(false);
    const onEnded = () => {
      setEnded(true);
      setControlsOn(true);
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("durationchange", onDuration);
    v.addEventListener("loadedmetadata", onDuration);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("volumechange", onVolume);
    v.addEventListener("ratechange", onRate);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("canplay", onPlaying);
    v.addEventListener("progress", readBuffered);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("durationchange", onDuration);
      v.removeEventListener("loadedmetadata", onDuration);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("volumechange", onVolume);
      v.removeEventListener("ratechange", onRate);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("canplay", onPlaying);
      v.removeEventListener("progress", readBuffered);
      v.removeEventListener("ended", onEnded);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (singleTapTimer.current) window.clearTimeout(singleTapTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.ended) {
      v.currentTime = 0;
      void v.play().catch(() => undefined);
    } else if (v.paused) {
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }

  function seekBy(seconds: number) {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(Math.max(v.currentTime + seconds, 0), v.duration);
    setTime(v.currentTime);
    setEnded(v.ended);
  }

  function toggleMute() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.5;
  }

  function toggleFullscreen() {
    const wrap = wrapRef.current;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (wrap?.requestFullscreen) {
      wrap.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
    } else {
      // iPhone Safari: no element fullscreen; use the native video presenter.
      v?.webkitEnterFullscreen?.();
    }
  }

  function flashSkip(side: "back" | "forward") {
    seekBy(side === "back" ? -10 : 10);
    setSkip({ side, id: Date.now() });
    window.setTimeout(() => setSkip((current) => (current?.side === side ? null : current)), 700);
  }

  // Keyboard shortcuts (YouTube-style). Attached per player instance.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const v = videoRef.current;
      if (!v) return;
      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          event.preventDefault();
          seekBy(-5);
          break;
        case "ArrowRight":
          event.preventDefault();
          seekBy(5);
          break;
        case "j":
          seekBy(-10);
          break;
        case "l":
          seekBy(10);
          break;
        case "ArrowUp":
          event.preventDefault();
          v.volume = Math.min(1, v.volume + 0.1);
          v.muted = false;
          break;
        case "ArrowDown":
          event.preventDefault();
          v.volume = Math.max(0, v.volume - 0.1);
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFullscreen();
          break;
        default:
          if (/^[0-9]$/.test(event.key) && Number.isFinite(v.duration)) {
            v.currentTime = (Number(event.key) / 10) * v.duration;
            setTime(v.currentTime);
          } else {
            return;
          }
      }
      bumpControls();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tap/click on the stage: mouse toggles play (double-click fullscreens);
  // touch toggles the controls, double-tap on the side thirds skips ±10s.
  function handleStagePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    lastPointerType.current = event.pointerType;
    if (event.pointerType === "mouse") {
      togglePlay();
      bumpControls();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = rect.width ? (event.clientX - rect.left) / rect.width : 0.5;
    const now = Date.now();
    const last = lastTap.current;
    lastTap.current = { time: now, x: event.clientX };
    if (last && now - last.time < DOUBLE_TAP_MS && Math.abs(event.clientX - last.x) < 80) {
      lastTap.current = null;
      if (singleTapTimer.current) {
        window.clearTimeout(singleTapTimer.current);
        singleTapTimer.current = null;
      }
      if (fraction < 0.35) flashSkip("back");
      else if (fraction > 0.65) flashSkip("forward");
      else togglePlay();
      bumpControls();
      return;
    }
    singleTapTimer.current = window.setTimeout(() => {
      singleTapTimer.current = null;
      if (menuRef.current !== "none") {
        setMenu("none");
        return;
      }
      setControlsOn((on) => {
        if (on) {
          if (hideTimer.current) window.clearTimeout(hideTimer.current);
          return false;
        }
        bumpControls();
        return true;
      });
    }, DOUBLE_TAP_MS);
  }

  function handleStageDoubleClick() {
    if (lastPointerType.current === "mouse") toggleFullscreen();
  }

  function railFraction(event: React.PointerEvent): number {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  function handleRailPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubbing.current = true;
    const v = videoRef.current;
    scrubWasPlaying.current = Boolean(v && !v.paused && !v.ended);
    v?.pause();
    setScrub(railFraction(event));
    bumpControls();
  }

  function handleRailPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (scrubbing.current) {
      setScrub(railFraction(event));
      bumpControls();
    } else if (event.pointerType === "mouse") {
      setHover(railFraction(event));
    }
  }

  function handleRailPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    const fraction = railFraction(event);
    const v = videoRef.current;
    if (v && duration > 0) {
      v.currentTime = fraction * duration;
      setTime(v.currentTime);
      setEnded(false);
    }
    setScrub(null);
    if (scrubWasPlaying.current) void v?.play().catch(() => undefined);
    bumpControls();
  }

  function selectLevel(level: number) {
    const hls = hlsRef.current;
    if (hls) hls.currentLevel = level;
    setManualLevel(level);
    setMenu("none");
  }

  function selectMp4Quality(quality: "hd" | "sd") {
    const v = videoRef.current;
    if (v) resumeRef.current = { time: v.currentTime, playing: !v.paused && !v.ended };
    setUseMp4(true);
    setMp4Quality(quality);
    setMenu("none");
  }

  function selectAutoSource() {
    const v = videoRef.current;
    if (v) resumeRef.current = { time: v.currentTime, playing: !v.paused && !v.ended };
    setUseMp4(false);
    setMenu("none");
  }

  type MenuOption = { key: string; label: string; active: boolean; onSelect: () => void };

  function qualityOptions(): MenuOption[] {
    if (engine === "hls") {
      const auto: MenuOption = {
        key: "auto",
        label: manualLevel === -1 && autoHeight ? `Auto (${autoHeight}p)` : "Auto",
        active: manualLevel === -1,
        onSelect: () => selectLevel(-1)
      };
      const manual = levels
        .map((height, index) => ({ height, index }))
        .sort((a, b) => b.height - a.height)
        .map(({ height, index }) => ({
          key: `l${index}`,
          label: `${height}p`,
          active: manualLevel === index,
          onSelect: () => selectLevel(index)
        }));
      return [auto, ...manual];
    }
    const options: MenuOption[] = [];
    if (asset.urls.hls) {
      options.push({ key: "auto", label: "Auto", active: !useMp4, onSelect: selectAutoSource });
    }
    options.push({ key: "hd", label: "1080p", active: useMp4 && mp4Quality === "hd", onSelect: () => selectMp4Quality("hd") });
    if (asset.urls.videoSd) {
      options.push({ key: "sd", label: "480p", active: useMp4 && mp4Quality === "sd", onSelect: () => selectMp4Quality("sd") });
    }
    return options;
  }

  const displayFraction = scrub ?? (duration > 0 ? Math.min(1, time / duration) : 0);
  const bufferedFraction = duration > 0 ? Math.min(1, buffered / duration) : 0;
  const previewFraction = scrub ?? hover;
  const storyboard = asset.storyboard && asset.urls.storyboard ? asset.storyboard : null;
  const qualityLabel = engine === "hls"
    ? (manualLevel === -1 ? "Auto" : `${levels[manualLevel] ?? "?"}p`)
    : engine === "native"
      ? "Auto"
      : mp4Quality === "hd"
        ? "1080p"
        : "480p";

  let preview: React.ReactNode = null;
  if (previewFraction != null && duration > 0) {
    const previewTime = previewFraction * duration;
    let thumb: React.ReactNode = null;
    let halfWidth = 36;
    if (storyboard) {
      const index = Math.min(storyboard.count - 1, Math.max(0, Math.floor(previewTime / storyboard.interval)));
      const col = index % storyboard.cols;
      const rowIndex = Math.floor(index / storyboard.cols);
      halfWidth = storyboard.tileWidth / 2 + 4;
      thumb = (
        <div
          className="vp-preview-thumb"
          style={{
            width: storyboard.tileWidth,
            height: storyboard.tileHeight,
            backgroundImage: `url(${asset.urls.storyboard})`,
            backgroundPosition: `-${col * storyboard.tileWidth}px -${rowIndex * storyboard.tileHeight}px`,
            backgroundSize: `${storyboard.cols * storyboard.tileWidth}px ${storyboard.rows * storyboard.tileHeight}px`
          }}
        />
      );
    }
    preview = (
      <div
        className="vp-preview"
        style={{ left: `clamp(${halfWidth}px, ${previewFraction * 100}%, calc(100% - ${halfWidth}px))` }}
      >
        {thumb}
        <span className="vp-preview-time">{formatDuration(previewTime * 1000)}</span>
      </div>
    );
  }

  const menuItems = menu === "speed"
    ? PLAYBACK_RATES.map((value) => ({
        key: `r${value}`,
        label: value === 1 ? "Normal" : `${value}×`,
        active: rate === value,
        onSelect: () => {
          const v = videoRef.current;
          if (v) {
            v.playbackRate = value;
            v.defaultPlaybackRate = value;
          }
          prefs.current = { ...prefs.current, rate: value };
          localStorage.setItem(playerPrefsKey, JSON.stringify(prefs.current));
          setMenu("none");
        }
      }))
    : menu === "quality"
      ? qualityOptions()
      : [];

  return (
    <div className={controlsOn ? "vp" : "vp controls-hidden"} ref={wrapRef} onPointerMove={(event) => {
      if (event.pointerType === "mouse") bumpControls();
    }}>
      <video
        className="vp-video"
        playsInline
        poster={asset.urls.preview}
        preload="metadata"
        ref={videoRef}
      />
      <div className="vp-tap" onDoubleClick={handleStageDoubleClick} onPointerUp={handleStagePointerUp} />
      {skip && (
        <div className={`vp-skip ${skip.side}`} key={skip.id}>
          {skip.side === "back" ? "-10s" : "+10s"}
        </div>
      )}
      {stalled && playing && !ended && (
        <div className="vp-center passive"><Loader className="spin" size={40} /></div>
      )}
      {(!playing || ended) && !stalled && (
        <button className="vp-center" onClick={togglePlay} title={ended ? "Replay" : "Play"} type="button">
          {ended ? <RotateCcw size={30} /> : <Play size={30} />}
        </button>
      )}
      <div className="vp-controls" onPointerUp={(event) => event.stopPropagation()}>
        <div
          className="vp-scrub"
          onPointerCancel={handleRailPointerUp}
          onPointerDown={handleRailPointerDown}
          onPointerLeave={() => setHover(null)}
          onPointerMove={handleRailPointerMove}
          onPointerUp={handleRailPointerUp}
        >
          {preview}
          <div className="vp-rail" ref={railRef}>
            <div className="vp-rail-buffered" style={{ width: `${bufferedFraction * 100}%` }} />
            <div className="vp-rail-played" style={{ width: `${displayFraction * 100}%` }} />
            <div className="vp-knob" style={{ left: `${displayFraction * 100}%` }} />
          </div>
        </div>
        <div className="vp-buttons">
          <button className="vp-button" onClick={togglePlay} title={playing ? "Pause (k)" : "Play (k)"} type="button">
            {ended ? <RotateCcw size={22} /> : playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <button className="vp-button" onClick={toggleMute} title={muted ? "Unmute (m)" : "Mute (m)"} type="button">
            {muted || volume === 0 ? <VolumeX size={22} /> : <Volume2 size={22} />}
          </button>
          <input
            aria-label="Volume"
            className="vp-volume"
            max={1}
            min={0}
            onChange={(event) => {
              const v = videoRef.current;
              if (!v) return;
              v.volume = Number(event.target.value);
              v.muted = false;
            }}
            step={0.05}
            type="range"
            value={muted ? 0 : volume}
          />
          <span className="vp-time">
            {formatDuration(Math.round(displayFraction * duration * 1000))} / {formatDuration(Math.round(duration * 1000))}
          </span>
          <span className="vp-spacer" />
          <button
            className={rate !== 1 ? "vp-button text active" : "vp-button text"}
            onClick={() => setMenu((current) => (current === "speed" ? "none" : "speed"))}
            title="Playback speed"
            type="button"
          >
            {rate === 1 ? "1×" : `${rate}×`}
          </button>
          <button
            className={engine === "hls" && manualLevel !== -1 ? "vp-button text active" : "vp-button text"}
            onClick={() => setMenu((current) => (current === "quality" ? "none" : "quality"))}
            title="Quality"
            type="button"
          >
            {qualityLabel}
          </button>
          <button className="vp-button" onClick={toggleFullscreen} title="Fullscreen (f)" type="button">
            {fullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
          </button>
        </div>
        {menu !== "none" && (
          <div className="vp-menu">
            {menuItems.map((item) => (
              <button className={item.active ? "active" : ""} key={item.key} onClick={item.onSelect} type="button">
                <span className="vp-menu-check">{item.active ? <Check size={16} /> : null}</span>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SharedViewer({
  asset,
  assets,
  onClose,
  onSelect
}: {
  asset: Asset;
  assets: Asset[];
  onClose: () => void;
  onSelect: (asset: Asset) => void;
}) {
  const index = assets.findIndex((item) => item.id === asset.id);
  const previous = index > 0 ? assets[index - 1] : null;
  const next = index >= 0 && index < assets.length - 1 ? assets[index + 1] : null;
  return <ViewerStage asset={asset} next={next} onClose={onClose} onSelect={onSelect} previous={previous} />;
}

function Viewer({
  activeAlbum,
  albums,
  asset,
  assets,
  onAddToAlbum,
  onClose,
  onDelete,
  onMutate,
  onSelect,
  onSetCover
}: {
  activeAlbum: Album | null;
  albums: Album[];
  asset: Asset;
  assets: Asset[];
  onAddToAlbum: (albumId: string, assetId: string) => Promise<void>;
  onClose: () => void;
  onDelete: (asset: Asset) => Promise<void>;
  onMutate: (asset: Asset, patch: Partial<Pick<Asset, "favorite" | "archived" | "trashed">>) => Promise<void>;
  onSelect: (asset: Asset) => void;
  onSetCover: (albumId: string, assetId: string) => Promise<void>;
}) {
  const [showInfo, setShowInfo] = useState(() => localStorage.getItem(viewerInfoStorageKey) === "true");
  const index = assets.findIndex((item) => item.id === asset.id);
  const previous = index > 0 ? assets[index - 1] : null;
  const next = index >= 0 && index < assets.length - 1 ? assets[index + 1] : null;

  function toggleInfo() {
    setShowInfo((current) => {
      const nextValue = !current;
      localStorage.setItem(viewerInfoStorageKey, String(nextValue));
      return nextValue;
    });
  }

  const actions = (
    <>
      <button className={asset.favorite ? "icon-button light active" : "icon-button light"} onClick={() => void onMutate(asset, { favorite: !asset.favorite })} title="Favorite" type="button"><Heart size={20} /></button>
      <button className="icon-button light" onClick={() => void onMutate(asset, { archived: !asset.archived })} title="Archive" type="button"><Archive size={20} /></button>
      <button className="icon-button light" onClick={() => void onMutate(asset, { trashed: !asset.trashed })} title="Trash" type="button"><Trash2 size={20} /></button>
      <button className={showInfo ? "icon-button light active" : "icon-button light"} onClick={toggleInfo} title={showInfo ? "Hide info" : "Show info"} type="button"><Info size={20} /></button>
    </>
  );

  const panel = showInfo ? (
    <aside className="info-panel">
      <div className="info-grip" />
      <h2>{asset.originalName}</h2>
      <dl>
        <div><dt>Date</dt><dd>{prettyDate(asset.takenAt)}</dd></div>
        <div><dt>Size</dt><dd>{formatBytes(asset.sizeBytes)}</dd></div>
        <div><dt>Dimensions</dt><dd>{asset.width && asset.height ? `${asset.width} x ${asset.height}` : "Unknown"}</dd></div>
        {asset.mediaType === "video" && asset.durationMs ? (
          <div><dt>Duration</dt><dd>{formatDuration(asset.durationMs)}</dd></div>
        ) : null}
        <div><dt>Type</dt><dd>{asset.mimeType}</dd></div>
      </dl>
      <div className="info-actions">
        {asset.urls.original && (
          <a className="secondary-button" href={asset.urls.original} target="_blank" rel="noreferrer">Download</a>
        )}
        {activeAlbum && (
          <button className="secondary-button" onClick={() => void onSetCover(activeAlbum.id, asset.id)} type="button">Set as cover</button>
        )}
        {asset.trashed ? (
          <button className="danger-button" onClick={() => void onDelete(asset)} type="button">Delete permanently</button>
        ) : (
          <button className="secondary-button" onClick={() => void onMutate(asset, { trashed: true })} type="button">Move to trash</button>
        )}
      </div>
      {!!albums.length && (
        <div className="album-pick">
          <span>Add to album</span>
          {albums.map((album) => (
            <button key={album.id} onClick={() => void onAddToAlbum(album.id, asset.id)} type="button">{album.title}</button>
          ))}
        </div>
      )}
    </aside>
  ) : undefined;

  return (
    <ViewerStage
      actions={actions}
      asset={asset}
      infoOpen={showInfo}
      next={next}
      onClose={onClose}
      onSelect={onSelect}
      panel={panel}
      previous={previous}
    />
  );
}

function LibraryView({
  activeAlbum,
  assets,
  busy,
  onAddExisting,
  onBack,
  onEditAlbum = () => {},
  onSelect,
  onSetCover,
  onShare,
  onUnshare,
  onStartSelect = () => {},
  onToggleSelect = () => {},
  onUpload,
  selectMode = false,
  selectedIds = new Set<string>(),
  uploadHint,
}: {
  activeAlbum: Album | null;
  assets: Asset[];
  busy: boolean;
  onAddExisting: () => void;
  onBack: () => void;
  onEditAlbum?: () => void;
  onSelect: (asset: Asset) => void;
  onSetCover?: (albumId: string, assetId: string) => Promise<void>;
  onShare: (album: Album) => Promise<void>;
  onUnshare?: (album: Album) => Promise<void>;
  onStartSelect?: (id: string) => void;
  onToggleSelect?: (id: string) => void;
  onUpload: () => void;
  selectMode?: boolean;
  selectedIds?: Set<string>;
  uploadHint?: string;
}) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const longPressFired = useRef(false);

  function cancelPress() {
    if (press.current) {
      clearTimeout(press.current.timer);
      press.current = null;
    }
  }

  function handlePointerDown(event: React.PointerEvent, assetId: string) {
    if (selectMode) return;
    longPressFired.current = false;
    cancelPress();
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        longPressFired.current = true;
        press.current = null;
        onStartSelect(assetId);
      }, LONG_PRESS_MS)
    };
  }

  function handlePointerMove(event: React.PointerEvent) {
    const start = press.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE) {
      cancelPress();
    }
  }

  function handleTileClick(asset: Asset) {
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    if (selectMode) {
      onToggleSelect(asset.id);
    } else {
      onSelect(asset);
    }
  }

  if (busy && assets.length === 0) return <GridSkeleton />;

  if (!assets.length) {
    return (
      <section className="empty-state">
        {activeAlbum && (
          <AlbumActionBar album={activeAlbum} onAddExisting={onAddExisting} onBack={onBack} onEdit={onEditAlbum} onShare={onShare} onUnshare={onUnshare} onUpload={onUpload} />
        )}
        <div className="empty-icon"><Images size={38} /></div>
        <h2>No items here</h2>
        <button className="primary-button" onClick={onUpload} title={uploadHint} type="button">
          <ImagePlus size={18} />
          <span>Upload</span>
        </button>
        {uploadHint && <p className="upload-hint">{uploadHint}</p>}
      </section>
    );
  }

  return (
    <>
      <section className="library">
        {activeAlbum && (
          <AlbumActionBar album={activeAlbum} onAddExisting={onAddExisting} onBack={onBack} onEdit={onEditAlbum} onShare={onShare} onUnshare={onUnshare} onUpload={onUpload} />
        )}
        {groupAssets(assets).map((group) => (
          <div className="date-group" key={group.label}>
            <h2>{group.label}</h2>
            <div className="photo-grid">
              {group.assets.map((asset) => {
                const isSelected = selectedIds.has(asset.id);
                return (
                  <button
                    className={`photo-tile${selectMode ? " selectable" : ""}${isSelected ? " is-selected" : ""}`}
                    key={asset.id}
                    onClick={() => handleTileClick(asset)}
                    onPointerDown={(event) => handlePointerDown(event, asset.id)}
                    onPointerUp={cancelPress}
                    onPointerMove={handlePointerMove}
                    onPointerCancel={cancelPress}
                    onContextMenu={(e) => e.preventDefault()}
                    type="button"
                  >
                    <img src={asset.urls.thumb} alt={asset.originalName} loading="lazy" draggable={false} />
                    <VideoTileOverlay asset={asset} />
                    {selectMode
                      ? <span className={`tile-checkbox${isSelected ? " checked" : ""}`} />
                      : <>
                          {asset.favorite && <span className="tile-badge"><Heart size={14} fill="currentColor" /></span>}
                          {activeAlbum && onSetCover && (
                            <span
                              className="tile-cover-btn"
                              onClick={(e) => { e.stopPropagation(); void onSetCover(activeAlbum.id, asset.id); }}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void onSetCover(activeAlbum.id, asset.id);
                                }
                              }}
                              title="Set as album cover"
                            ><Star size={12} /></span>
                          )}
                        </>
                    }
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function DropArea({
  children,
  dragging,
  hint,
  onDragChange,
  onDrop
}: {
  children: React.ReactNode;
  dragging: boolean;
  hint?: string;
  onDragChange: (dragging: boolean) => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
}) {
  return (
    <section
      className={dragging ? "drop-area dragging" : "drop-area"}
      onDragEnter={(event) => {
        event.preventDefault();
        onDragChange(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        onDragChange(false);
      }}
      onDrop={onDrop}
    >
      {children}
      {dragging && (
        <div className="drop-overlay">
          <ImagePlus size={36} />
          <strong>Drop files to upload</strong>
          {hint && <span className="drop-hint">{hint}</span>}
        </div>
      )}
    </section>
  );
}

function AlbumActionBar({
  album,
  onAddExisting,
  onBack,
  onEdit,
  onShare,
  onUnshare,
  onUpload
}: {
  album: Album;
  onAddExisting: () => void;
  onBack: () => void;
  onEdit: () => void;
  onShare: (album: Album) => Promise<void>;
  onUnshare?: (album: Album) => Promise<void>;
  onUpload: () => void;
}) {
  return (
    <div className="album-actions">
      <button className="text-button" onClick={onBack} type="button">
        <ChevronLeft size={18} /> Albums
      </button>
      <div>
        <button className="secondary-button" onClick={onEdit} type="button">
          <Pencil size={18} />
          <span>Edit</span>
        </button>
        <button className="secondary-button" onClick={onAddExisting} type="button">
          <Images size={18} />
          <span>Add existing</span>
        </button>
        <button className="secondary-button" onClick={onUpload} type="button">
          <ImagePlus size={18} />
          <span>Upload here</span>
        </button>
        {album.shareUrl && onUnshare && (
          <button className="secondary-button" onClick={() => void onUnshare(album)} type="button">
            <X size={18} />
            <span>Stop sharing</span>
          </button>
        )}
        <button className="primary-button" onClick={() => void onShare(album)} type="button">
          <Sparkles size={18} />
          <span>{album.shareUrl ? "Copy share link" : "Create share link"}</span>
        </button>
      </div>
    </div>
  );
}

function AlbumsView({
  albums,
  onCreate,
  onOpen,
  onShare
}: {
  albums: Album[];
  onCreate: (title: string, files?: FileList | null) => Promise<Album>;
  onOpen: (album: Album) => void;
  onShare: (album: Album) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const inputId = useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    await onCreate(title.trim(), files);
    setTitle("");
    setFiles(null);
  }

  return (
    <section className="albums-layout">
      <form className="album-create" onSubmit={submit}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="New album" />
        <label className="secondary-button album-file-picker" htmlFor={inputId}>
          <ImagePlus size={18} />
          <span>{files?.length ? `${files.length} selected` : "Photos"}</span>
        </label>
        <input id={inputId} className="hidden-input" type="file" accept="image/*,video/*" multiple onChange={(event) => setFiles(event.target.files)} />
        <button className="primary-button" type="submit"><Plus size={18} /><span>Create</span></button>
      </form>
      <div className="album-grid">
        {albums.map((album) => (
          <div className="album-tile" key={album.id}>
            <button className="album-open" onClick={() => onOpen(album)} type="button">
              {album.coverAssetId
                ? <img className="album-cover" src={`/api/assets/${album.coverAssetId}/file/thumb`} alt={album.title} />
                : <div className="album-art"><Images size={32} /></div>
              }
              <div className="album-label">
                <strong>{album.title}</strong>
                <span>{album.assetCount ?? 0} item{album.assetCount === 1 ? "" : "s"}</span>
              </div>
            </button>
            <button className="icon-button" onClick={() => void onShare(album)} title="Share album" type="button">
              <Sparkles size={18} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function AddExistingModal({
  album,
  albumAssets,
  assets,
  onAdd,
  onClose
}: {
  album: Album;
  albumAssets: Asset[];
  assets: Asset[];
  onAdd: (assetIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const existingIds = useMemo(() => new Set(albumAssets.map((asset) => asset.id)), [albumAssets]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const candidates = assets.filter((asset) => !existingIds.has(asset.id));
  const groups = groupAssets(candidates);
  useBodyScrollLock();
  useBackClose(true, onClose);

  function toggleAsset(assetId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  function toggleDay(dayAssets: Asset[]) {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = dayAssets.every((asset) => next.has(asset.id));
      for (const asset of dayAssets) {
        if (allSelected) next.delete(asset.id);
        else next.add(asset.id);
      }
      return next;
    });
  }

  async function submit() {
    if (!selectedIds.size) return;
    await onAdd([...selectedIds]);
    onClose();
  }

  return (
    <Overlay>
      <div className="modal-backdrop" onClick={onClose}>
        <section className="modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-head">
            <div>
              <p className="eyebrow">{candidates.length} available</p>
              <h2>Add to {album.title}</h2>
            </div>
            <button className="icon-button" onClick={onClose} title="Close" type="button"><X size={18} /></button>
          </div>
          {candidates.length ? (
            <div className="picker-scroll">
              {groups.map((group) => {
                const selectedCount = group.assets.reduce((count, asset) => count + (selectedIds.has(asset.id) ? 1 : 0), 0);
                const allSelected = selectedCount === group.assets.length;
                return (
                  <div className="picker-day" key={group.label}>
                    <div className="picker-day-head">
                      <h3>{group.label}</h3>
                      <button className="picker-day-toggle" onClick={() => toggleDay(group.assets)} type="button">
                        <span aria-hidden className={allSelected ? "day-checkbox checked" : "day-checkbox"} />
                        <span>
                          {allSelected
                            ? "All selected"
                            : selectedCount
                              ? `${selectedCount} of ${group.assets.length}`
                              : "Select day"}
                        </span>
                      </button>
                    </div>
                    <div className="picker-grid">
                      {group.assets.map((asset) => {
                        const checked = selectedIds.has(asset.id);
                        return (
                          <button
                            className={checked ? "picker-tile selected" : "picker-tile"}
                            key={asset.id}
                            onClick={() => toggleAsset(asset.id)}
                            title={asset.originalName}
                            type="button"
                          >
                            <img src={asset.urls.thumb} alt={asset.originalName} loading="lazy" />
                            <VideoTileOverlay asset={asset} />
                            <span className={checked ? "tile-checkbox checked" : "tile-checkbox"} />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-inline">Every available photo is already in this album.</div>
          )}
          <div className="modal-actions">
            <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-button" disabled={!selectedIds.size} onClick={() => void submit()} type="button">
              Add {selectedIds.size || ""}
            </button>
          </div>
        </section>
      </div>
    </Overlay>
  );
}

function EditAlbumModal({
  album,
  onClose,
  onDelete,
  onRename
}: {
  album: Album;
  onClose: () => void;
  onDelete: (deleteAssets: boolean) => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(album.title);
  const [deleteAssets, setDeleteAssets] = useState(false);
  const trimmed = title.trim();
  useBodyScrollLock();
  useBackClose(true, onClose);

  return (
    <Overlay>
      <div className="modal-backdrop" onClick={onClose}>
        <section className="modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-head">
            <div>
              <p className="eyebrow">Album settings</p>
              <h2>{album.title}</h2>
            </div>
            <button className="icon-button" onClick={onClose} title="Close" type="button"><X size={18} /></button>
          </div>
          <div className="edit-album-body">
            <form
              className="edit-album-rename"
              onSubmit={(event) => {
                event.preventDefault();
                if (trimmed && trimmed !== album.title) void onRename(trimmed);
              }}
            >
              <input
                aria-label="Album title"
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
              <button className="primary-button" disabled={!trimmed || trimmed === album.title} type="submit">
                Rename
              </button>
            </form>
            <div className="danger-zone">
              <label className="check-label">
                <input
                  checked={deleteAssets}
                  onChange={(event) => setDeleteAssets(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  Also move the album&apos;s {album.assetCount} item{album.assetCount === 1 ? "" : "s"} to the trash
                </span>
              </label>
              <button className="danger-button" onClick={() => onDelete(deleteAssets)} type="button">
                <Trash2 size={18} />
                <span>Delete album</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </Overlay>
  );
}

function AdminPanel({ currentUser }: { currentUser: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [error, setError] = useState("");

  useEffect(() => {
    void loadUsers();
  }, []);

  async function loadUsers() {
    const data = await api<{ users: User[] }>("/api/admin/users");
    setUsers(data.users);
  }

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email, name, password, role })
      });
      setEmail("");
      setName("");
      setPassword("");
      setRole("user");
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create user.");
    }
  }

  async function updateUser(user: User, patch: Partial<User> & { password?: string }) {
    setError("");
    try {
      await api(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update user.");
    }
    await loadUsers();
  }

  async function deleteUser(user: User) {
    const confirmed = window.confirm(`Delete ${user.email}? This permanently removes the account and all photos.`);
    if (!confirmed) return;
    setError("");
    try {
      await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete user.");
    }
    await loadUsers();
  }

  return (
    <section className="admin-layout">
      <form className="admin-create" onSubmit={createUser}>
        <div className="section-title">
          <UserPlus size={20} />
          <h2>Add user</h2>
        </div>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" />
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" type="email" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" type="password" />
        <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit"><Plus size={18} /><span>Add</span></button>
      </form>

      <div className="users-panel">
        <div className="section-title">
          <Users size={20} />
          <h2>Users</h2>
        </div>
        <div className="user-list">
          {users.map((user) => (
            <div className="user-row" key={user.id}>
              <div>
                <strong>{user.name}</strong>
                <span>{user.email}</span>
              </div>
              <select
                value={user.role}
                disabled={user.id === currentUser.id}
                onChange={(event) => void updateUser(user, { role: event.target.value as Role })}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <label className="switch">
                <input
                  checked={!user.disabled}
                  disabled={user.id === currentUser.id}
                  onChange={(event) => void updateUser(user, { disabled: !event.target.checked })}
                  type="checkbox"
                />
                <span />
              </label>
              <button className="icon-button" disabled={user.id === currentUser.id} onClick={() => void deleteUser(user)} title="Delete" type="button">
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function GridSkeleton() {
  return (
    <div className="photo-grid skeleton-grid">
      {Array.from({ length: 16 }).map((_, index) => <div className="skeleton-tile" key={index} />)}
    </div>
  );
}

function Splash() {
  return (
    <div className="splash">
      <div className="brand-mark"><Camera size={28} /></div>
    </div>
  );
}

type UploadResult = {
  assets: Asset[];
  duplicates?: Asset[];
  errors: Array<{ name: string; error: string }>;
};

// Cloudflare rejects requests over 100MB with a 413, so uploads are split
// into batches that stay safely below that. File count is capped too so one
// batch can't hold hundreds of tiny files.
const UPLOAD_BATCH_BYTES = 80 * 1024 * 1024;
const UPLOAD_BATCH_FILES = 40;

function batchForUpload(files: File[]): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let currentBytes = 0;
  for (const file of files) {
    if (current.length && (currentBytes + file.size > UPLOAD_BATCH_BYTES || current.length >= UPLOAD_BATCH_FILES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function uploadWithProgress(url: string, form: FormData, onProgress: (loadedBytes: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    xhr.addEventListener("load", () => {
      const body = xhr.response as (UploadResult & { error?: string }) | null;
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
      else reject(new Error(body?.error || `Upload failed with ${xhr.status}.`));
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
    xhr.send(form);
  });
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/me" && !url.startsWith("/api/auth/")) {
      // Session expired while the app was open — reload lands on the login screen.
      window.location.reload();
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const error = await response.json().catch(() => ({ error: "" }));
      throw new Error(error.error || `Request failed with ${response.status}.`);
    }
    const text = await response.text().catch(() => "");
    const shortText = text.replace(/\s+/g, " ").trim().slice(0, 140);
    throw new Error(shortText || `Request failed with ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

function groupAssets(assets: Asset[]) {
  const groups = new Map<string, Asset[]>();
  for (const asset of assets) {
    const label = prettyDate(asset.takenAt);
    groups.set(label, [...(groups.get(label) ?? []), asset]);
  }
  return Array.from(groups, ([label, groupAssets]) => ({ label, assets: groupAssets }));
}

function prettyDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function formatMb(mb: number) {
  return mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`;
}

function formatDuration(ms: number) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Play icon / processing / failed overlay drawn over a video tile's thumbnail. */
function VideoTileOverlay({ asset }: { asset: Asset }) {
  if (asset.mediaType !== "video") return null;
  if (asset.status === "processing") {
    return <span className="tile-video processing"><Loader size={16} className="spin" /></span>;
  }
  if (asset.status === "failed") {
    return <span className="tile-video failed" title="Processing failed"><AlertTriangle size={16} /></span>;
  }
  return (
    <span className="tile-video">
      <Play size={18} fill="currentColor" />
      {asset.durationMs ? <span className="tile-duration">{formatDuration(asset.durationMs)}</span> : null}
    </span>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

function labelFor(view: View) {
  return view.charAt(0).toUpperCase() + view.slice(1);
}

createRoot(document.getElementById("root")!).render(<App />);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
