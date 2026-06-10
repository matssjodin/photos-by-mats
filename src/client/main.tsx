import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  Archive,
  Camera,
  ChevronLeft,
  ChevronRight,
  Heart,
  ImagePlus,
  Images,
  Info,
  LogOut,
  Plus,
  Search,
  Shield,
  Sparkles,
  Star,
  Trash2,
  UserPlus,
  Users,
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
  urls: {
    thumb: string;
    preview: string;
    original: string | null;
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

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
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

  if (booting) return <Splash />;
  if (shareToken) return <SharedAlbum token={shareToken} />;
  if (!user) return <Login onLogin={setUser} />;
  return <PhotosApp user={user} onLogout={() => setUser(null)} />;
}

function PhotosApp({ user, onLogout }: { user: User; onLogout: () => void }) {
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
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmRequest | null>(null);
  const [linkPrompt, setLinkPrompt] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!message || busy) return;
    const id = setTimeout(() => setMessage(""), 3500);
    return () => clearTimeout(id);
  }, [message, busy]);

  // The viewer's "Add to album" list needs albums before the Albums tab is visited.
  useEffect(() => {
    void loadAlbums();
  }, []);

  function confirmAction(request: ConfirmRequest) {
    setConfirmState(request);
  }

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

  async function loadAssets(nextView = view) {
    setBusy(true);
    try {
      const data = await api<{ assets: Asset[] }>(`/api/assets?view=${nextView}&q=${encodeURIComponent(search)}`);
      setAssets(data.assets);
    } finally {
      setBusy(false);
    }
  }

  async function loadAlbums() {
    const data = await api<{ albums: Album[] }>("/api/albums");
    setAlbums(data.albums);
  }

  async function loadAlbumAssets(albumId: string) {
    setBusy(true);
    try {
      const data = await api<{ assets: Asset[] }>(`/api/albums/${albumId}/assets`);
      setAssets(data.assets);
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhotos(files: FileList | File[] | null, albumId = activeAlbum?.id) {
    if (!files?.length) return;
    const form = new FormData();
    Array.from(files).forEach((file) => form.append("photos", file));
    setBusy(true);
    setMessage("Uploading");
    try {
      const endpoint = albumId ? `/api/albums/${albumId}/upload` : "/api/assets";
      const response = await fetch(endpoint, { method: "POST", body: form });
      if (!response.ok) throw new Error((await response.json()).error ?? "Upload failed.");
      setMessage("");
      if (albumId) {
        await loadAlbumAssets(albumId);
        await loadAlbums();
      } else {
        await loadAssets("photos");
        setView("photos");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
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
    setAssets((current) => removesFromView
      ? current.filter((item) => item.id !== data.asset.id)
      : current.map((item) => item.id === data.asset.id ? data.asset : item));
    if (patch.trashed !== undefined) void loadAlbums();
  }

  async function deleteAsset(asset: Asset) {
    return new Promise<void>((resolve) => {
      confirmAction({
        title: "Delete photo permanently?",
        body: "This removes the original, preview, and thumbnail from disk. It cannot be undone.",
        confirmLabel: "Delete permanently",
        danger: true,
        onConfirm: async () => {
          await api(`/api/assets/${asset.id}`, { method: "DELETE" });
          setSelected(null);
          setAssets((current) => current.filter((item) => item.id !== asset.id));
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
  }

  async function openAddModal() {
    const data = await api<{ assets: Asset[] }>("/api/assets?view=photos");
    setLibraryAssets(data.assets);
    setAddModalOpen(true);
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

  async function trashSelected() {
    const ids = [...selectedIds];
    clearSelect();
    await Promise.all(ids.map((id) =>
      api(`/api/assets/${id}`, { method: "PATCH", body: JSON.stringify({ trashed: true }) })
    ));
    setAssets((current) => current.filter((a) => !ids.includes(a.id)));
    void loadAlbums();
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Camera size={22} /></div>
          <span>Sjodin Photos</span>
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
              <button className="primary-button" onClick={() => fileInput.current?.click()} type="button">
                <ImagePlus size={18} />
                <span>Upload</span>
              </button>
            )}
            <input
              ref={fileInput}
              className="hidden-input"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => void uploadPhotos(event.target.files)}
            />
          </div>
        </header>

        {view === "trash" && (
          <p className="view-note">Photos in the trash are deleted permanently after 30 days.</p>
        )}
        {view === "admin" ? (
          <AdminPanel currentUser={user} />
        ) : view === "albums" && !activeAlbum ? (
          <AlbumsView albums={albums} onCreate={createAlbum} onOpen={setActiveAlbum} onShare={shareAlbum} />
        ) : (
          <DropArea dragging={dragging} onDragChange={setDragging} onDrop={handleDrop}>
            <LibraryView
              activeAlbum={activeAlbum}
              assets={visibleAssets}
              busy={busy}
              onAddExisting={openAddModal}
              onBack={() => setActiveAlbum(null)}
              onClearSelect={clearSelect}
              onSelect={setSelected}
              onSetCover={activeAlbum ? setCoverPhoto : undefined}
              onShare={shareAlbum}
              onStartSelect={startSelect}
              onToggleSelect={toggleSelect}
              onTrashSelected={trashSelected}
              onUpload={() => fileInput.current?.click()}
              selectMode={selectMode}
              selectedIds={selectedIds}
            />
          </DropArea>
        )}
      </main>

      {message && <Overlay><div className="toast">{message}</div></Overlay>}

      {addModalOpen && activeAlbum && (
        <AddExistingModal
          album={activeAlbum}
          albumAssets={assets}
          assets={libraryAssets}
          onAdd={(ids) => addToAlbum(activeAlbum.id, ids)}
          onClose={() => setAddModalOpen(false)}
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

function Login({ onLogin }: { onLogin: (user: User) => void }) {
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
          <span>Sjodin Photos</span>
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

function SharedAlbum({ token }: { token: string }) {
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
          <span>Sjodin Photos</span>
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
  const gesture = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const justSwiped = useRef(false);
  useBodyScrollLock();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && previous) onSelect(previous);
      if (event.key === "ArrowRight" && next) onSelect(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous, onClose, onSelect]);

  useEffect(() => {
    for (const neighbour of [previous, next]) {
      if (neighbour) {
        const preload = new Image();
        preload.src = neighbour.urls.preview;
      }
    }
  }, [previous?.id, next?.id]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse") return;
    // Pointer capture would redirect the eventual click away from toolbar
    // buttons, so gestures rely on bubbling instead — and never start on one.
    if ((event.target as HTMLElement).closest("button")) return;
    gesture.current = { x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
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

  function handlePointerEnd() {
    const current = gesture.current;
    gesture.current = null;
    const img = imgRef.current;
    if (!current || !img) return;
    justSwiped.current = Math.hypot(current.dx, current.dy) > 10;
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
          className="viewer-stage"
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
            <div className="viewer-actions">{actions}</div>
          </div>
          {previous && (
            <button className="viewer-nav previous" onClick={() => onSelect(previous)} title="Previous" type="button">
              <ChevronLeft size={28} />
            </button>
          )}
          <img
            alt={asset.originalName}
            className="viewer-image"
            draggable={false}
            key={asset.id}
            ref={imgRef}
            src={asset.urls.preview}
          />
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
        <div><dt>Type</dt><dd>{asset.mimeType}</dd></div>
      </dl>
      <div className="info-actions">
        {asset.urls.original && (
          <a className="secondary-button" href={asset.urls.original} target="_blank" rel="noreferrer">Original</a>
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
  onClearSelect = () => {},
  onSelect,
  onSetCover,
  onShare,
  onStartSelect = () => {},
  onToggleSelect = () => {},
  onTrashSelected = async () => {},
  onUpload,
  selectMode = false,
  selectedIds = new Set<string>(),
}: {
  activeAlbum: Album | null;
  assets: Asset[];
  busy: boolean;
  onAddExisting: () => void;
  onBack: () => void;
  onClearSelect?: () => void;
  onSelect: (asset: Asset) => void;
  onSetCover?: (albumId: string, assetId: string) => Promise<void>;
  onShare: (album: Album) => Promise<void>;
  onStartSelect?: (id: string) => void;
  onToggleSelect?: (id: string) => void;
  onTrashSelected?: () => Promise<void>;
  onUpload: () => void;
  selectMode?: boolean;
  selectedIds?: Set<string>;
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
          <AlbumActionBar album={activeAlbum} onAddExisting={onAddExisting} onBack={onBack} onShare={onShare} onUpload={onUpload} />
        )}
        <div className="empty-icon"><Images size={38} /></div>
        <h2>No photos here</h2>
        <button className="primary-button" onClick={onUpload} type="button">
          <ImagePlus size={18} />
          <span>Upload</span>
        </button>
      </section>
    );
  }

  return (
    <>
      <section className="library">
        {activeAlbum && (
          <AlbumActionBar album={activeAlbum} onAddExisting={onAddExisting} onBack={onBack} onShare={onShare} onUpload={onUpload} />
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
      {selectMode && (
        <Overlay>
          <div className="select-bar">
            <span>{selectedIds.size} photo{selectedIds.size === 1 ? "" : "s"} selected</span>
            <div className="select-bar-actions">
              <button className="secondary-button" onClick={onClearSelect} type="button">Cancel</button>
              <button className="danger-button" disabled={selectedIds.size === 0} onClick={() => void onTrashSelected()} type="button">
                <Trash2 size={18} /><span>Trash</span>
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </>
  );
}

function DropArea({
  children,
  dragging,
  onDragChange,
  onDrop
}: {
  children: React.ReactNode;
  dragging: boolean;
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
          <strong>Drop photos to upload</strong>
        </div>
      )}
    </section>
  );
}

function AlbumActionBar({
  album,
  onAddExisting,
  onBack,
  onShare,
  onUpload
}: {
  album: Album;
  onAddExisting: () => void;
  onBack: () => void;
  onShare: (album: Album) => Promise<void>;
  onUpload: () => void;
}) {
  return (
    <div className="album-actions">
      <button className="text-button" onClick={onBack} type="button">
        <ChevronLeft size={18} /> Albums
      </button>
      <div>
        <button className="secondary-button" onClick={onAddExisting} type="button">
          <Images size={18} />
          <span>Add existing</span>
        </button>
        <button className="secondary-button" onClick={onUpload} type="button">
          <ImagePlus size={18} />
          <span>Upload here</span>
        </button>
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
        <input id={inputId} className="hidden-input" type="file" accept="image/*" multiple onChange={(event) => setFiles(event.target.files)} />
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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const candidates = assets.filter((asset) => !existingIds.has(asset.id));
  useBodyScrollLock();

  async function submit() {
    if (!selectedIds.length) return;
    await onAdd(selectedIds);
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
            <div className="picker-grid">
              {candidates.map((asset) => {
                const checked = selectedIds.includes(asset.id);
                return (
                  <button
                    className={checked ? "picker-tile selected" : "picker-tile"}
                    key={asset.id}
                    onClick={() => setSelectedIds((current) => checked ? current.filter((id) => id !== asset.id) : [...current, asset.id])}
                    type="button"
                  >
                    <img src={asset.urls.thumb} alt={asset.originalName} loading="lazy" />
                    <span>{checked ? "Selected" : asset.originalName}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="empty-inline">Every available photo is already in this album.</div>
          )}
          <div className="modal-actions">
            <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-button" disabled={!selectedIds.length} onClick={() => void submit()} type="button">
              Add {selectedIds.length || ""}
            </button>
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
