import { ZipArchive } from "archiver";
import cookie from "cookie";
import express from "express";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import exifrPkg from "exifr";
const parseExif = exifrPkg.parse.bind(exifrPkg);
import { fileURLToPath } from "node:url";

const ffmpegPath = ffmpegStatic as unknown as string;
const ffprobePath = ffprobeStatic.path;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const clientDir = path.resolve(rootDir, "dist-client");
const port = Number(process.env.PORT ?? 4000);
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const uploadsDir = path.join(dataDir, "uploads");
const tempDir = path.join(dataDir, "tmp");
const dbPath = path.join(dataDir, "photos.sqlite");
const sessionCookie = "sjodin_session";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;
const maxUploadFiles = Number(process.env.MAX_UPLOAD_FILES ?? 500);
const maxUploadFileSizeMb = Number(process.env.MAX_UPLOAD_FILE_SIZE_MB ?? 120);
const maxUploadVideoSizeMb = Number(process.env.MAX_UPLOAD_VIDEO_SIZE_MB ?? 2048);
const isProduction = process.env.NODE_ENV === "production";
const appOrigin = process.env.APP_ORIGIN?.replace(/\/$/, "");
const ingestConcurrency = Math.max(1, Number(process.env.INGEST_CONCURRENCY ?? 3));
const videoConcurrency = Math.max(1, Number(process.env.VIDEO_CONCURRENCY ?? 1));
const trashRetentionDays = Number(process.env.TRASH_RETENTION_DAYS ?? 30);
// White-label branding: shown in the UI, the page title, and the PWA manifest.
const appName = (process.env.APP_NAME ?? "").trim() || "Sjodin Photos";
const appShortName = (process.env.APP_SHORT_NAME ?? "").trim() || "Photos";
// Attribution link shown at the bottom of shared album pages. Defaults apply
// when the variables are unset; set ATTRIBUTION_TEXT="" to hide it entirely.
const attributionText = (process.env.ATTRIBUTION_TEXT ?? "Photoalbum by Mats Sjödin").trim();
const attributionUrl = (process.env.ATTRIBUTION_URL ?? "https://matssjodin.com").trim();

const loginAttempts = new Map<string, { count: number; firstAttempt: number; lockedUntil: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const DUMMY_HASH = crypto.pbkdf2Sync("dummy", "dummy", 310000, 32, "sha256").toString("hex");
const DUMMY_SALT = "dummy";

type Role = "admin" | "user";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  salt: string;
  disabled: number;
  created_at: string;
};

type AssetRow = {
  id: string;
  user_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  taken_at: string;
  created_at: string;
  favorite: number;
  archived: number;
  trashed: number;
  trashed_at: string | null;
  original_path: string;
  preview_path: string;
  thumb_path: string;
  content_hash: string | null;
  media_type: string;
  status: string;
  duration_ms: number | null;
  video_path: string | null;
  video_sd_path: string | null;
};

type AlbumRow = {
  id: string;
  user_id: string;
  title: string;
  share_token: string | null;
  created_at: string;
  asset_count?: number;
  cover_asset_id?: string | null;
};

type AuthedRequest = express.Request & { user: PublicUser };

type PublicUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
};

const app = express();
app.set("trust proxy", 1);
const upload = multer({
  dest: tempDir,
  limits: {
    // multer enforces a single per-file size cap, so use the larger (video)
    // limit here; the image-specific cap is enforced in ingestAsset().
    fileSize: 1024 * 1024 * Math.max(maxUploadFileSizeMb, maxUploadVideoSizeMb),
    files: maxUploadFiles
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image and video files can be uploaded."));
  }
});

await fs.mkdir(uploadsDir, { recursive: true });
await fs.mkdir(tempDir, { recursive: true });

// Multer stages uploads in tempDir; anything left there is from a crashed upload.
for (const entry of await fs.readdir(tempDir)) {
  await fs.rm(path.join(tempDir, entry), { recursive: true, force: true }).catch(() => undefined);
}

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    taken_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    trashed INTEGER NOT NULL DEFAULT 0,
    original_path TEXT NOT NULL,
    preview_path TEXT NOT NULL,
    thumb_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    share_token TEXT UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS album_assets (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (album_id, asset_id)
  );
`);

ensureColumn("albums", "share_token", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_share_token ON albums(share_token) WHERE share_token IS NOT NULL");
ensureColumn("albums", "cover_asset_id", "TEXT");
ensureColumn("assets", "content_hash", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_user_hash ON assets(user_id, content_hash) WHERE content_hash IS NOT NULL");
ensureColumn("assets", "trashed_at", "TEXT");
ensureColumn("assets", "media_type", "TEXT NOT NULL DEFAULT 'image'");
ensureColumn("assets", "status", "TEXT NOT NULL DEFAULT 'ready'");
ensureColumn("assets", "duration_ms", "INTEGER");
ensureColumn("assets", "video_path", "TEXT");
ensureColumn("assets", "video_sd_path", "TEXT");
// Photos trashed before this column existed start their retention clock now.
db.prepare("UPDATE assets SET trashed_at = ? WHERE trashed = 1 AND trashed_at IS NULL").run(new Date().toISOString());
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id, trashed, archived);
  CREATE INDEX IF NOT EXISTS idx_albums_user ON albums(user_id);
  CREATE INDEX IF NOT EXISTS idx_album_assets_asset ON album_assets(asset_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);
ensureAdminAccount();

app.use(securityHeaders);
app.use(express.json({ limit: "1mb" }));
app.use(csrfGuard);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.json({ appName, appShortName, attributionText, attributionUrl, maxUploadFileSizeMb, maxUploadVideoSizeMb });
});

app.get("/api/share/:token", (req, res) => {
  const token = String(req.params.token);
  const album = db.prepare("SELECT * FROM albums WHERE share_token = ?").get(token) as AlbumRow | undefined;
  if (!album) {
    res.status(404).json({ error: "Shared album not found." });
    return;
  }

  const assets = db.prepare(`
    SELECT assets.* FROM album_assets
    JOIN assets ON assets.id = album_assets.asset_id
    WHERE album_assets.album_id = ? AND assets.trashed = 0
    ORDER BY assets.taken_at ASC, assets.original_name ASC
  `).all(album.id) as AssetRow[];

  res.json({
    album: toPublicAlbum(album),
    assets: assets.map((asset) => toPublicAsset(asset, token))
  });
});

app.get("/api/share/:token/file/:assetId/:variant", (req, res) => {
  const token = String(req.params.token);
  const assetId = String(req.params.assetId);
  const variant = String(req.params.variant);
  const album = db.prepare("SELECT * FROM albums WHERE share_token = ?").get(token) as AlbumRow | undefined;
  if (!album || !["thumb", "preview", "video", "video_sd"].includes(variant)) {
    res.status(404).json({ error: "Shared asset not found." });
    return;
  }

  const asset = db.prepare(`
    SELECT assets.* FROM album_assets
    JOIN assets ON assets.id = album_assets.asset_id
    WHERE album_assets.album_id = ? AND assets.id = ? AND assets.trashed = 0
  `).get(album.id, assetId) as AssetRow | undefined;
  if (!asset) {
    res.status(404).json({ error: "Shared asset not found." });
    return;
  }

  let relPath = "";
  if (variant === "thumb") relPath = asset.thumb_path;
  else if (variant === "preview") relPath = asset.preview_path;
  else if (variant === "video") relPath = (asset.status === "ready" && asset.video_path) || "";
  else if (variant === "video_sd") relPath = (asset.status === "ready" && asset.video_sd_path) || "";
  if (!relPath) {
    res.status(404).json({ error: "Shared asset not found." });
    return;
  }
  sendAssetFile(res, relPath);
});

app.post("/api/auth/login", (req, res) => {
  const ip = clientIp(req);
  if (isLoginLocked(ip)) {
    res.status(429).json({ error: "Too many login attempts. Please try again in a few minutes." });
    return;
  }

  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const user = db
    .prepare("SELECT * FROM users WHERE lower(email) = lower(?)")
    .get(email.trim()) as UserRow | undefined;

  const valid = user && !user.disabled && verifyPassword(password, user.salt, user.password_hash);
  if (!valid) {
    if (!user) verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
    recordFailedLogin(ip);
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }

  recordSuccessfulLogin(ip);
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionTtlMs;
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(token, user.id, expiresAt, new Date().toISOString());

  res.setHeader("Set-Cookie", cookie.serialize(sessionCookie, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: Math.floor(sessionTtlMs / 1000)
  }));
  res.json({ user: toPublicUser(user) });
});

app.use("/api", requireAuth);

app.get("/api/me", (req, res) => {
  res.json({ user: (req as AuthedRequest).user });
});

app.post("/api/auth/logout", (req, res) => {
  const token = readSessionToken(req);
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }
  res.setHeader("Set-Cookie", cookie.serialize(sessionCookie, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 0
  }));
  res.json({ ok: true });
});

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as UserRow[];
  res.json({ users: users.map(toPublicUser) });
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { email, name, password, role } = req.body as {
    email?: string;
    name?: string;
    password?: string;
    role?: Role;
  };

  if (!email || !password || password.length < 10) {
    res.status(400).json({ error: "Email and a password of at least 10 characters are required." });
    return;
  }

  const userRole: Role = role === "admin" ? "admin" : "user";
  const userName = name?.trim() || email.split("@")[0];
  const credentials = hashPassword(password);
  const id = crypto.randomUUID();

  try {
    db.prepare(`
      INSERT INTO users (id, email, name, role, password_hash, salt, disabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, email.trim().toLowerCase(), userName, userRole, credentials.hash, credentials.salt, new Date().toISOString());
  } catch {
    res.status(409).json({ error: "A user with that email already exists." });
    return;
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  res.status(201).json({ user: toPublicUser(user) });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const currentUser = authUser(req);
  const { name, role, disabled, password } = req.body as {
    name?: string;
    role?: Role;
    disabled?: boolean;
    password?: string;
  };

  const userId = String(req.params.id);
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  if (currentUser.id === existing.id && (disabled || role === "user")) {
    res.status(400).json({ error: "You cannot remove your own admin access." });
    return;
  }

  const nextName = name?.trim() || existing.name;
  const nextRole = role === "admin" ? "admin" : role === "user" ? "user" : existing.role;
  const nextDisabled = typeof disabled === "boolean" ? Number(disabled) : existing.disabled;

  if (password) {
    if (password.length < 10) {
      res.status(400).json({ error: "Password must be at least 10 characters." });
      return;
    }
    const credentials = hashPassword(password);
    db.prepare(`
      UPDATE users SET name = ?, role = ?, disabled = ?, password_hash = ?, salt = ? WHERE id = ?
    `).run(nextName, nextRole, nextDisabled, credentials.hash, credentials.salt, existing.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND user_id != ?").run(existing.id, currentUser.id);
  } else {
    db.prepare("UPDATE users SET name = ?, role = ?, disabled = ? WHERE id = ?")
      .run(nextName, nextRole, nextDisabled, existing.id);
    if (nextDisabled && !existing.disabled) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
    }
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id) as UserRow;
  res.json({ user: toPublicUser(user) });
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const currentUser = authUser(req);
  const userId = String(req.params.id);
  if (currentUser.id === userId) {
    res.status(400).json({ error: "You cannot delete your own account." });
    return;
  }

  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const userAssetDir = path.join(uploadsDir, existing.id);
  try {
    await fs.rm(userAssetDir, { recursive: true, force: true });
  } catch (error) {
    console.error("Failed to remove user asset directory:", error);
    res.status(500).json({ error: "Could not delete user files. Aborted." });
    return;
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(existing.id);
  res.json({ ok: true });
});

app.get("/api/assets", (req, res) => {
  const user = authUser(req);
  const view = String(req.query.view ?? "photos");
  const search = String(req.query.q ?? "").trim();
  const where = ["user_id = ?"];
  const params: (string | number | null)[] = [user.id];

  if (view === "favorites") where.push("favorite = 1", "trashed = 0");
  else if (view === "archive") where.push("archived = 1", "trashed = 0");
  else if (view === "trash") where.push("trashed = 1");
  else where.push("archived = 0", "trashed = 0");

  if (search) {
    where.push("(lower(original_name) LIKE lower(?) OR substr(taken_at, 1, 10) LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const assets = db.prepare(`
    SELECT * FROM assets
    WHERE ${where.join(" AND ")}
    ORDER BY taken_at DESC, created_at DESC
  `).all(...params) as AssetRow[];

  const sharedIds = sharedAlbumAssetIds(user.id);
  res.json({ assets: assets.map((asset) => toPublicAsset(asset, undefined, sharedIds.has(asset.id))) });
});

app.post("/api/assets", upload.array("photos", maxUploadFiles), async (req, res, next) => {
  try {
    const user = authUser(req);
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) {
      res.status(400).json({ error: "No image files were uploaded." });
      return;
    }

    const outcomes = await processConcurrent(files, ingestConcurrency, (file) => ingestAsset(user.id, file));
    const created: ReturnType<typeof toPublicAsset>[] = [];
    const duplicates: ReturnType<typeof toPublicAsset>[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    outcomes.forEach((outcome, index) => {
      if (!outcome.ok) errors.push({ name: files[index].originalname, error: outcome.error.message });
      else if (outcome.value.duplicate) duplicates.push(outcome.value.asset);
      else created.push(outcome.value.asset);
    });

    if (!created.length && !duplicates.length) {
      res.status(500).json({ error: "Upload failed.", errors });
      return;
    }
    res.status(201).json({ assets: created, duplicates, errors });
  } catch (error) {
    next(error);
  }
});

app.get("/api/assets/:id/file/:variant", (req, res) => {
  const user = authUser(req);
  const asset = findOwnedAsset(String(req.params.id), user);
  if (!asset) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }

  const variant = req.params.variant;
  const isVideo = asset.media_type === "video";
  // For images, "original" serves the stored 2048px WebP (the uploaded source
  // is discarded at ingest). For videos it serves the 1080p MP4.
  let relPath = "";
  if (variant === "thumb") relPath = asset.thumb_path;
  else if (variant === "preview") relPath = asset.preview_path;
  else if (variant === "video") relPath = (isVideo && asset.status === "ready" && asset.video_path) || "";
  else if (variant === "video_sd") relPath = (isVideo && asset.status === "ready" && asset.video_sd_path) || "";
  else if (variant === "original") relPath = isVideo ? (asset.status === "ready" && asset.video_path) || "" : asset.preview_path;

  if (!relPath) {
    res.status(404).json({ error: "Variant not found." });
    return;
  }
  if (variant === "original") {
    const name = isVideo ? videoDownloadName(asset.original_name) : webpDownloadName(asset.original_name);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"`);
  }
  sendAssetFile(res, relPath);
});

app.patch("/api/assets/:id", (req, res) => {
  const user = authUser(req);
  const asset = findOwnedAsset(String(req.params.id), user);
  if (!asset) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }

  const { favorite, archived, trashed } = req.body as {
    favorite?: boolean;
    archived?: boolean;
    trashed?: boolean;
  };

  const nextTrashed = typeof trashed === "boolean" ? Number(trashed) : asset.trashed;
  db.prepare(`
    UPDATE assets
    SET favorite = ?, archived = ?, trashed = ?, trashed_at = ?
    WHERE id = ?
  `).run(
    typeof favorite === "boolean" ? Number(favorite) : asset.favorite,
    typeof archived === "boolean" ? Number(archived) : asset.archived,
    nextTrashed,
    nextTrashed ? (asset.trashed_at ?? new Date().toISOString()) : null,
    asset.id
  );

  const updated = db.prepare("SELECT * FROM assets WHERE id = ?").get(asset.id) as AssetRow;
  res.json({ asset: toPublicAsset(updated, undefined, assetInSharedAlbum(user.id, asset.id)) });
});

app.delete("/api/assets/:id", async (req, res) => {
  const user = authUser(req);
  const asset = findOwnedAsset(String(req.params.id), user);
  if (!asset) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }

  await deleteAssetCompletely(asset);
  res.json({ ok: true });
});

app.post("/api/trash/empty", async (req, res) => {
  const user = authUser(req);
  const trashed = db.prepare("SELECT * FROM assets WHERE user_id = ? AND trashed = 1").all(user.id) as AssetRow[];
  for (const asset of trashed) {
    await deleteAssetCompletely(asset);
  }
  res.json({ ok: true, deleted: trashed.length });
});

app.post("/api/assets/zip", (req, res) => {
  const user = authUser(req);
  const { assetIds } = req.body as { assetIds?: string[] };
  const ids = Array.isArray(assetIds) ? assetIds.slice(0, 500).map(String) : [];
  const assets = ids
    .map((id) => findOwnedAsset(id, user))
    .filter((asset): asset is AssetRow => Boolean(asset));
  if (!assets.length) {
    res.status(404).json({ error: "No matching photos." });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="photos.zip"');

  // Store-only: the WebP files are already compressed.
  const archive = new ZipArchive({ store: true });
  archive.on("error", (error: Error) => {
    console.error("Zip stream failed:", error);
    res.destroy();
  });
  archive.pipe(res);

  const usedNames = new Set<string>();
  for (const asset of assets) {
    const isReadyVideo = asset.media_type === "video" && asset.status === "ready" && asset.video_path;
    let name = isReadyVideo ? videoDownloadName(asset.original_name) : webpDownloadName(asset.original_name);
    if (usedNames.has(name)) {
      const ext = path.extname(name);
      name = `${name.slice(0, name.length - ext.length)}-${asset.id.slice(0, 8)}${ext}`;
    }
    usedNames.add(name);
    archive.file(path.join(dataDir, isReadyVideo ? asset.video_path! : asset.preview_path), { name });
  }
  void archive.finalize();
});

app.get("/api/albums", (req, res) => {
  const user = authUser(req);
  const albums = db.prepare(`
    SELECT
      albums.id, albums.user_id, albums.title, albums.share_token, albums.created_at,
      (
        SELECT COUNT(*) FROM album_assets aa
        JOIN assets ON assets.id = aa.asset_id
        WHERE aa.album_id = albums.id AND assets.trashed = 0
      ) AS asset_count,
      COALESCE(
        albums.cover_asset_id,
        (
          SELECT assets.id FROM album_assets aa
          JOIN assets ON assets.id = aa.asset_id
          WHERE aa.album_id = albums.id AND assets.trashed = 0
          ORDER BY aa.added_at DESC LIMIT 1
        )
      ) AS cover_asset_id
    FROM albums
    WHERE albums.user_id = ?
    ORDER BY albums.created_at DESC
  `).all(user.id) as AlbumRow[];
  res.json({ albums: albums.map(toPublicAlbum) });
});

app.post("/api/albums", (req, res) => {
  const user = authUser(req);
  const title = String((req.body as { title?: string }).title ?? "").trim();
  if (!title) {
    res.status(400).json({ error: "Album title is required." });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO albums (id, user_id, title, share_token, created_at) VALUES (?, ?, ?, NULL, ?)")
    .run(id, user.id, title, new Date().toISOString());
  res.status(201).json({ album: toPublicAlbum(getAlbumById(id)) });
});

app.patch("/api/albums/:id", (req, res) => {
  const user = authUser(req);
  const albumId = String(req.params.id);
  const { coverAssetId, title } = req.body as { coverAssetId?: string | null; title?: string };

  const existing = db.prepare("SELECT * FROM albums WHERE id = ? AND user_id = ?").get(albumId, user.id) as AlbumRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Album not found." });
    return;
  }

  if (title !== undefined) {
    const trimmed = String(title).trim();
    if (!trimmed) {
      res.status(400).json({ error: "Album title is required." });
      return;
    }
    db.prepare("UPDATE albums SET title = ? WHERE id = ?").run(trimmed, albumId);
  }

  if (coverAssetId !== undefined) {
    if (coverAssetId) {
      const asset = findOwnedAsset(String(coverAssetId), user);
      if (!asset) {
        res.status(404).json({ error: "Asset not found." });
        return;
      }
    }
    db.prepare("UPDATE albums SET cover_asset_id = ? WHERE id = ?").run(coverAssetId || null, albumId);
  }

  res.json({ album: toPublicAlbum(getAlbumById(albumId)) });
});

app.post("/api/albums/:id/upload", upload.array("photos", maxUploadFiles), async (req, res, next) => {
  try {
    const user = authUser(req);
    const albumId = String(req.params.id);
    const album = db.prepare("SELECT * FROM albums WHERE id = ? AND user_id = ?").get(albumId, user.id);
    if (!album) {
      res.status(404).json({ error: "Album not found." });
      return;
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) {
      res.status(400).json({ error: "No image files were uploaded." });
      return;
    }

    const outcomes = await processConcurrent(files, ingestConcurrency, (file) => ingestAsset(user.id, file));
    const created: ReturnType<typeof toPublicAsset>[] = [];
    const duplicates: ReturnType<typeof toPublicAsset>[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    const insertAlbumAsset = db.prepare("INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, ?)");
    outcomes.forEach((outcome, index) => {
      if (!outcome.ok) {
        errors.push({ name: files[index].originalname, error: outcome.error.message });
        return;
      }
      try {
        // Duplicates still get linked: re-sharing an existing photo into an album is the intent.
        insertAlbumAsset.run(albumId, outcome.value.asset.id, new Date().toISOString());
        if (outcome.value.duplicate) duplicates.push(outcome.value.asset);
        else created.push(outcome.value.asset);
      } catch (error) {
        if (!outcome.value.duplicate) {
          db.prepare("DELETE FROM assets WHERE id = ?").run(outcome.value.asset.id);
        }
        errors.push({ name: files[index].originalname, error: (error as Error).message });
      }
    });

    if (!created.length && !duplicates.length) {
      res.status(500).json({ error: "Upload failed.", errors });
      return;
    }
    res.status(201).json({ assets: created, duplicates, errors });
  } catch (error) {
    next(error);
  }
});

app.get("/api/albums/:id/assets", (req, res) => {
  const user = authUser(req);
  const albumId = String(req.params.id);
  const album = db.prepare("SELECT * FROM albums WHERE id = ? AND user_id = ?").get(albumId, user.id);
  if (!album) {
    res.status(404).json({ error: "Album not found." });
    return;
  }
  const assets = db.prepare(`
    SELECT assets.* FROM album_assets
    JOIN assets ON assets.id = album_assets.asset_id
    WHERE album_assets.album_id = ? AND assets.trashed = 0
    ORDER BY assets.taken_at ASC, assets.original_name ASC
  `).all(albumId) as AssetRow[];
  const sharedIds = sharedAlbumAssetIds(user.id);
  res.json({ assets: assets.map((asset) => toPublicAsset(asset, undefined, sharedIds.has(asset.id))) });
});

app.post("/api/albums/:id/assets", (req, res) => {
  const user = authUser(req);
  const albumId = String(req.params.id);
  const { assetId, assetIds } = req.body as { assetId?: string; assetIds?: string[] };
  const album = db.prepare("SELECT * FROM albums WHERE id = ? AND user_id = ?").get(albumId, user.id);
  if (!album) {
    res.status(404).json({ error: "Album not found." });
    return;
  }

  const ids = assetIds?.length ? assetIds : assetId ? [assetId] : [];
  if (!ids.length) {
    res.status(400).json({ error: "Choose at least one photo." });
    return;
  }

  const insert = db.prepare("INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, ?)");
  let added = 0;
  for (const id of ids) {
    const asset = findOwnedAsset(String(id), user);
    if (asset && !asset.trashed) {
      insert.run(albumId, asset.id, new Date().toISOString());
      added += 1;
    }
  }

  res.json({ ok: true, added });
});

app.post("/api/albums/:id/share", (req, res) => {
  const user = authUser(req);
  const albumId = String(req.params.id);
  const album = db.prepare("SELECT * FROM albums WHERE id = ? AND user_id = ?").get(albumId, user.id) as AlbumRow | undefined;
  if (!album) {
    res.status(404).json({ error: "Album not found." });
    return;
  }

  const token = album.share_token ?? crypto.randomBytes(18).toString("base64url");
  db.prepare("UPDATE albums SET share_token = ? WHERE id = ?").run(token, albumId);
  res.json({ album: toPublicAlbum(getAlbumById(albumId)) });
});

app.delete("/api/albums/:id/share", (req, res) => {
  const user = authUser(req);
  const albumId = String(req.params.id);
  const album = db.prepare("SELECT * FROM albums WHERE id = ? AND user_id = ?").get(albumId, user.id) as AlbumRow | undefined;
  if (!album) {
    res.status(404).json({ error: "Album not found." });
    return;
  }
  db.prepare("UPDATE albums SET share_token = NULL WHERE id = ?").run(albumId);
  res.json({ album: toPublicAlbum(getAlbumById(albumId)) });
});

app.delete("/api/albums/:id/assets/:assetId", (req, res) => {
  const user = authUser(req);
  const albumId = String(req.params.id);
  const assetId = String(req.params.assetId);
  const album = db.prepare("SELECT * FROM albums WHERE id = ? AND user_id = ?").get(albumId, user.id);
  if (!album) {
    res.status(404).json({ error: "Album not found." });
    return;
  }
  db.prepare("DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?").run(albumId, assetId);
  res.json({ ok: true });
});

app.delete("/api/albums/:id", (req, res) => {
  const user = authUser(req);
  const albumId = String(req.params.id);
  const album = db.prepare("SELECT * FROM albums WHERE id = ? AND user_id = ?").get(albumId, user.id);
  if (!album) {
    res.status(404).json({ error: "Album not found." });
    return;
  }

  // ?deleteAssets=1 also moves the album's photos to the trash (they keep the
  // normal retention window) rather than deleting files immediately.
  let trashed = 0;
  if (String(req.query.deleteAssets ?? "") === "1") {
    const result = db.prepare(`
      UPDATE assets SET trashed = 1, trashed_at = ?
      WHERE trashed = 0 AND user_id = ? AND id IN (
        SELECT asset_id FROM album_assets WHERE album_id = ?
      )
    `).run(new Date().toISOString(), user.id, albumId);
    trashed = Number(result.changes);
  }

  db.prepare("DELETE FROM albums WHERE id = ?").run(albumId);
  res.json({ ok: true, trashed });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});

// PWA share-target fallback: if the service worker didn't intercept the POST
// (first visit, SW disabled), bounce to the app instead of a 404.
app.post("/share-target", (_req, res) => {
  res.redirect(303, "/");
});

// Served dynamically (before the static dist-client copy) so APP_NAME and
// APP_SHORT_NAME white-label the installed PWA without a rebuild.
app.get("/manifest.webmanifest", (_req, res) => {
  res.type("application/manifest+json").json({
    name: appName,
    short_name: appShortName,
    description: `${appName} — private photo library`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f6f4ee",
    theme_color: "#102a2a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ],
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: { files: [{ name: "photos", accept: ["image/*", "video/*"] }] }
    }
  });
});

app.use(express.static(clientDir));
app.get(/.*/, async (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_COUNT") {
      res.status(413).json({ error: `Upload up to ${maxUploadFiles} images at a time.` });
      return;
    }
    if (error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: `Each image must be ${maxUploadFileSizeMb} MB or smaller.` });
      return;
    }
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof Error && (
    error.message === "Only image and video files can be uploaded." ||
    error.message.endsWith("MB limit.")
  )) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "Something went wrong." });
});

const server = app.listen(port, () => {
  console.log(`${appName} is running on port ${port}`);
  void backfillContentHashes()
    .catch((error) => console.error("Hash backfill failed:", error))
    .then(() => migrateOriginalsToWebp())
    .catch((error) => console.error("WebP migration failed:", error));
  resumeVideoProcessing();
});
// Node's 5s default races with the reverse proxies in front (Cloudflare and
// Coolify's proxy reuse idle origin connections): a request sent just as Node
// closes the socket hangs forever. Keep connections open longer than any
// proxy's idle timeout (Traefik 90s, Caddy 2min) so Node never closes first.
server.keepAliveTimeout = 185_000;
server.headersTimeout = 190_000;

function shutdown(signal: NodeJS.Signals) {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => {
    try {
      db.close();
    } catch (error) {
      console.error("Failed to close database cleanly:", error);
    }
    process.exit(0);
  });
  // In-flight uploads get 10 seconds to finish before a hard exit.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function getAlbumById(albumId: string): AlbumRow {
  return db.prepare(`
    SELECT
      albums.id, albums.user_id, albums.title, albums.share_token, albums.created_at,
      (SELECT COUNT(*) FROM album_assets aa JOIN assets ON assets.id = aa.asset_id WHERE aa.album_id = albums.id AND assets.trashed = 0) AS asset_count,
      COALESCE(
        albums.cover_asset_id,
        (
          SELECT assets.id FROM album_assets aa
          JOIN assets ON assets.id = aa.asset_id
          WHERE aa.album_id = albums.id AND assets.trashed = 0
          ORDER BY aa.added_at DESC LIMIT 1
        )
      ) AS cover_asset_id
    FROM albums WHERE id = ?
  `).get(albumId) as AlbumRow;
}

function ensureAdminAccount() {
  const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  const configuredEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const configuredPassword = process.env.ADMIN_PASSWORD;

  if (configuredEmail && configuredPassword) {
    upsertAdmin(configuredEmail, configuredPassword, "Admin");
    return;
  }

  if (userCount.count > 0) {
    if (configuredEmail && !configuredPassword) {
      console.warn("ADMIN_EMAIL is set but ADMIN_PASSWORD is missing, so the configured admin was not updated.");
    }
    return;
  }

  if (isProduction) {
    console.error("No users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set. Refusing to create a default admin in production.");
    process.exit(1);
  }

  upsertAdmin("admin@example.com", "change-me-before-deploy", "Admin");
  console.warn("Created development admin: admin@example.com / change-me-before-deploy");
}

function upsertAdmin(email: string, password: string, name: string) {
  const existing = db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email) as UserRow | undefined;
  const credentials = hashPassword(password);
  if (existing) {
    db.prepare(`
      UPDATE users
      SET name = ?, role = 'admin', password_hash = ?, salt = ?, disabled = 0
      WHERE id = ?
    `).run(existing.name || name, credentials.hash, credentials.salt, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO users (id, email, name, role, password_hash, salt, disabled, created_at)
    VALUES (?, ?, ?, 'admin', ?, ?, 0, ?)
  `).run(
    crypto.randomUUID(),
    email,
    name,
    credentials.hash,
    credentials.salt,
    new Date().toISOString()
  );
}

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password: string, salt: string, hash: string) {
  const attempted = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256");
  const expected = Buffer.from(hash, "hex");
  return expected.length === attempted.length && crypto.timingSafeEqual(expected, attempted);
}

function readSessionToken(req: express.Request) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  return cookie.parse(header)[sessionCookie];
}

function clientIp(req: express.Request) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isLoginLocked(ip: string) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  const now = Date.now();
  if (entry.lockedUntil > now) return true;
  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return false;
}

function recordFailedLogin(ip: string) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now, lockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
}

function recordSuccessfulLogin(ip: string) {
  loginAttempts.delete(ip);
}

function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  if (isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

function csrfGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  const origin = (req.headers.origin ?? "").toString();
  const referer = (req.headers.referer ?? "").toString();
  const host = (req.headers.host ?? "").toString();
  const expected = new Set<string>();
  if (host) {
    expected.add(`http://${host}`);
    expected.add(`https://${host}`);
  }
  if (appOrigin) expected.add(appOrigin);

  const fromOrigin = origin && [...expected].some((value) => origin === value);
  const fromReferer = !origin && referer && [...expected].some((value) => referer.startsWith(`${value}/`) || referer === value);

  if (fromOrigin || fromReferer) return next();
  res.status(403).json({ error: "Cross-origin request rejected." });
}

async function processConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: Error }> = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        const value = await fn(items[index]);
        results[index] = { ok: true, value };
      } catch (error) {
        results[index] = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function deleteAssetCompletely(asset: AssetRow) {
  db.prepare("UPDATE albums SET cover_asset_id = NULL WHERE cover_asset_id = ?").run(asset.id);
  db.prepare("DELETE FROM assets WHERE id = ?").run(asset.id);
  await fs.rm(path.dirname(path.join(dataDir, asset.original_path)), { recursive: true, force: true });
}

async function purgeExpiredTrash() {
  if (!(trashRetentionDays > 0)) return;
  const cutoff = new Date(Date.now() - trashRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const expired = db
    .prepare("SELECT * FROM assets WHERE trashed = 1 AND trashed_at IS NOT NULL AND trashed_at < ?")
    .all(cutoff) as AssetRow[];
  for (const asset of expired) {
    try {
      await deleteAssetCompletely(asset);
    } catch (error) {
      console.error(`Failed to purge trashed asset ${asset.id}:`, error);
    }
  }
  if (expired.length) {
    console.log(`Purged ${expired.length} asset(s) from trash (older than ${trashRetentionDays} days).`);
  }
}

function runMaintenance() {
  try {
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  } catch (error) {
    console.error("Session cleanup failed:", error);
  }
  void purgeExpiredTrash().catch((error) => console.error("Trash purge failed:", error));
}
runMaintenance();
setInterval(runMaintenance, 60 * 60 * 1000).unref();

function authUser(req: express.Request) {
  return (req as unknown as AuthedRequest).user;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = readSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as
    | { user_id: string; expires_at: number }
    | undefined;

  if (!session || session.expires_at < Date.now()) {
    if (session) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as UserRow | undefined;
  if (!user || user.disabled) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  (req as AuthedRequest).user = toPublicUser(user);
  next();
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as AuthedRequest).user;
  if (user.role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}

async function ingestAsset(userId: string, file: Express.Multer.File): Promise<{ asset: ReturnType<typeof toPublicAsset>; duplicate: boolean }> {
  const id = crypto.randomUUID();
  const relativeDir = path.join("uploads", userId, id);
  const absoluteDir = path.join(dataDir, relativeDir);
  const isVideo = file.mimetype.startsWith("video/");

  try {
    // multer allows the larger video size cap for every file, so enforce the
    // image-specific limit here.
    if (!isVideo && file.size > 1024 * 1024 * maxUploadFileSizeMb) {
      throw new Error(`Image exceeds the ${maxUploadFileSizeMb} MB limit.`);
    }

    // The uploaded original is discarded after processing: only the 2048px
    // WebP and the thumbnail are kept. The dedupe hash is still computed
    // from the uploaded bytes so re-uploads of the same source file match.
    const contentHash = await sha256File(file.path);
    const existing = db
      .prepare("SELECT * FROM assets WHERE user_id = ? AND content_hash = ?")
      .get(userId, contentHash) as AssetRow | undefined;
    if (existing) {
      await fs.rm(file.path, { force: true }).catch(() => undefined);
      return { asset: toPublicAsset(restoreIfTrashed(existing)), duplicate: true };
    }

    await fs.mkdir(absoluteDir, { recursive: true });

    if (isVideo) {
      return await ingestVideo(userId, id, file, relativeDir, absoluteDir, contentHash);
    }

    const previewPath = path.join(relativeDir, "preview.webp");
    const thumbPath = path.join(relativeDir, "thumb.webp");

    const previewInfo = await sharp(file.path)
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(path.join(dataDir, previewPath));
    await sharp(file.path)
      .rotate()
      .resize({ width: 560, height: 560, fit: "cover", position: "attention" })
      .webp({ quality: 76 })
      .toFile(path.join(dataDir, thumbPath));

    const now = new Date().toISOString();
    let takenAt = now;
    try {
      const tags = await parseExif(file.path, ["DateTimeOriginal", "CreateDate"]);
      const exifDate = tags?.DateTimeOriginal ?? tags?.CreateDate;
      if (exifDate instanceof Date && !isNaN(exifDate.getTime())) {
        takenAt = exifDate.toISOString();
      }
    } catch {
      // no EXIF date available
    }

    try {
      db.prepare(`
        INSERT INTO assets (
          id, user_id, original_name, mime_type, size_bytes, width, height,
          taken_at, created_at, original_path, preview_path, thumb_path, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        userId,
        file.originalname,
        "image/webp",
        previewInfo.size,
        previewInfo.width ?? null,
        previewInfo.height ?? null,
        takenAt,
        now,
        previewPath,
        previewPath,
        thumbPath,
        contentHash
      );
    } catch (error) {
      // Unique (user_id, content_hash) race: an identical file in the same
      // batch finished first. Treat this copy as the duplicate.
      const winner = db
        .prepare("SELECT * FROM assets WHERE user_id = ? AND content_hash = ?")
        .get(userId, contentHash) as AssetRow | undefined;
      if (!winner) throw error;
      await fs.rm(absoluteDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(file.path, { force: true }).catch(() => undefined);
      return { asset: toPublicAsset(restoreIfTrashed(winner)), duplicate: true };
    }

    await fs.rm(file.path, { force: true }).catch(() => undefined);
    const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow;
    return { asset: toPublicAsset(row), duplicate: false };
  } catch (error) {
    await fs.rm(absoluteDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(file.path, { force: true }).catch(() => undefined);
    throw error;
  }
}

// The uploaded video is staged under the asset dir as this fixed name so the
// background transcode (and restart recovery) can find it without a DB column.
const VIDEO_SOURCE_NAME = "source.bin";

/**
 * Fast, synchronous half of video ingest: probe the source, extract a poster
 * frame (so the existing <img> grid/backdrop works), stage the source for
 * transcoding, insert a `processing` row, and enqueue the heavy transcode.
 */
async function ingestVideo(
  userId: string,
  id: string,
  file: Express.Multer.File,
  relativeDir: string,
  absoluteDir: string,
  contentHash: string
): Promise<{ asset: ReturnType<typeof toPublicAsset>; duplicate: boolean }> {
  const probe = await probeVideo(file.path);

  const previewPath = path.join(relativeDir, "preview.webp");
  const thumbPath = path.join(relativeDir, "thumb.webp");
  const posterPng = path.join(absoluteDir, "poster.png");

  // Grab a frame a second in (or the very start for short clips). ffmpeg
  // auto-applies rotation metadata, so the poster is already display-oriented.
  const seek = probe.durationMs > 2000 ? 1 : 0;
  await runFfmpeg(["-y", "-ss", String(seek), "-i", file.path, "-frames:v", "1", "-an", posterPng]);

  const previewInfo = await sharp(posterPng)
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(path.join(dataDir, previewPath));
  await sharp(posterPng)
    .resize({ width: 560, height: 560, fit: "cover", position: "attention" })
    .webp({ quality: 76 })
    .toFile(path.join(dataDir, thumbPath));
  await fs.rm(posterPng, { force: true }).catch(() => undefined);

  // Stage the source inside the asset dir for the background transcode.
  await fs.rename(file.path, path.join(absoluteDir, VIDEO_SOURCE_NAME)).catch(async () => {
    await fs.copyFile(file.path, path.join(absoluteDir, VIDEO_SOURCE_NAME));
    await fs.rm(file.path, { force: true }).catch(() => undefined);
  });

  const now = new Date().toISOString();
  const takenAt = probe.createdAt ?? now;
  const videoPath = path.join(relativeDir, "video_1080.mp4");
  const videoSdPath = path.join(relativeDir, "video_480.mp4");

  try {
    db.prepare(`
      INSERT INTO assets (
        id, user_id, original_name, mime_type, size_bytes, width, height,
        taken_at, created_at, original_path, preview_path, thumb_path, content_hash,
        media_type, status, duration_ms, video_path, video_sd_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'video', 'processing', ?, ?, ?)
    `).run(
      id,
      userId,
      file.originalname,
      "video/mp4",
      previewInfo.size,
      previewInfo.width ?? null,
      previewInfo.height ?? null,
      takenAt,
      now,
      // original_path mirrors preview_path so the `<>` migration guard skips it
      // and deleteAssetCompletely() still wipes the whole asset dir.
      previewPath,
      previewPath,
      thumbPath,
      contentHash,
      probe.durationMs || null,
      videoPath,
      videoSdPath
    );
  } catch (error) {
    const winner = db
      .prepare("SELECT * FROM assets WHERE user_id = ? AND content_hash = ?")
      .get(userId, contentHash) as AssetRow | undefined;
    if (!winner) throw error;
    await fs.rm(absoluteDir, { recursive: true, force: true }).catch(() => undefined);
    return { asset: toPublicAsset(restoreIfTrashed(winner)), duplicate: true };
  }

  enqueueTranscode(id);
  const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow;
  return { asset: toPublicAsset(row), duplicate: false };
}

// ---- Background video transcode queue ----------------------------------

const transcodeQueue: string[] = [];
const transcodeQueued = new Set<string>();
let activeTranscodes = 0;

function enqueueTranscode(assetId: string) {
  if (transcodeQueued.has(assetId)) return;
  transcodeQueued.add(assetId);
  transcodeQueue.push(assetId);
  pumpTranscodeQueue();
}

function pumpTranscodeQueue() {
  while (activeTranscodes < videoConcurrency && transcodeQueue.length) {
    const assetId = transcodeQueue.shift()!;
    transcodeQueued.delete(assetId);
    activeTranscodes += 1;
    void transcodeAsset(assetId)
      .catch((error) => console.error(`Transcode failed for ${assetId}:`, error))
      .finally(() => {
        activeTranscodes -= 1;
        pumpTranscodeQueue();
      });
  }
}

async function transcodeAsset(assetId: string) {
  const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as AssetRow | undefined;
  if (!row || row.media_type !== "video" || !row.video_path || !row.video_sd_path) return;

  const sourcePath = path.join(path.dirname(path.join(dataDir, row.video_path)), VIDEO_SOURCE_NAME);
  if (!(await fileExists(sourcePath))) {
    db.prepare("UPDATE assets SET status = 'failed' WHERE id = ?").run(assetId);
    return;
  }

  try {
    const portrait = (row.height ?? 0) > (row.width ?? 0);
    await runFfmpeg(transcodeArgs(sourcePath, path.join(dataDir, row.video_path), portrait ? 1080 : 1920, portrait ? 1920 : 1080, 23, "128k"));
    await runFfmpeg(transcodeArgs(sourcePath, path.join(dataDir, row.video_sd_path), portrait ? 480 : 854, portrait ? 854 : 480, 26, "96k"));

    const stat = await fs.stat(path.join(dataDir, row.video_path)).catch(() => null);
    db.prepare("UPDATE assets SET status = 'ready', size_bytes = ? WHERE id = ?")
      .run(stat?.size ?? row.size_bytes, assetId);
    await fs.rm(sourcePath, { force: true }).catch(() => undefined);
  } catch (error) {
    db.prepare("UPDATE assets SET status = 'failed' WHERE id = ?").run(assetId);
    throw error;
  }
}

/** Build ffmpeg args for one H.264/AAC faststart MP4 that fits within boxW×boxH (no upscaling). */
function transcodeArgs(source: string, out: string, boxW: number, boxH: number, crf: number, audioBitrate: string): string[] {
  const scale = `scale=w=${boxW}:h=${boxH}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  return [
    "-y",
    "-i", source,
    "-vf", scale,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", audioBitrate,
    "-movflags", "+faststart",
    out
  ];
}

/** On boot, re-enqueue videos still marked `processing`; fail any whose source is gone. */
function resumeVideoProcessing() {
  const rows = db.prepare("SELECT id, video_path FROM assets WHERE media_type = 'video' AND status = 'processing'")
    .all() as Array<{ id: string; video_path: string | null }>;
  for (const row of rows) {
    if (!row.video_path) {
      db.prepare("UPDATE assets SET status = 'failed' WHERE id = ?").run(row.id);
      continue;
    }
    const sourcePath = path.join(path.dirname(path.join(dataDir, row.video_path)), VIDEO_SOURCE_NAME);
    if (existsSync(sourcePath)) {
      enqueueTranscode(row.id);
    } else {
      db.prepare("UPDATE assets SET status = 'failed' WHERE id = ?").run(row.id);
    }
  }
  if (rows.length) console.log(`Resumed video processing for ${rows.length} asset(s).`);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function probeVideo(filePath: string): Promise<{ durationMs: number; width: number | null; height: number | null; createdAt: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
        return;
      }
      try {
        const data = JSON.parse(stdout) as {
          format?: { duration?: string; tags?: Record<string, string> };
          streams?: Array<{ codec_type?: string; width?: number; height?: number; tags?: Record<string, string> }>;
        };
        const video = data.streams?.find((s) => s.codec_type === "video");
        const durationSec = Number(data.format?.duration ?? 0);
        const creation = data.format?.tags?.creation_time ?? video?.tags?.creation_time;
        const created = creation ? new Date(creation) : null;
        resolve({
          durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
          width: video?.width ?? null,
          height: video?.height ?? null,
          createdAt: created && !isNaN(created.getTime()) ? created.toISOString() : null
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function restoreIfTrashed(asset: AssetRow): AssetRow {
  if (!asset.trashed) return asset;
  db.prepare("UPDATE assets SET trashed = 0, trashed_at = NULL WHERE id = ?").run(asset.id);
  return db.prepare("SELECT * FROM assets WHERE id = ?").get(asset.id) as AssetRow;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/** One-time backfill of content hashes for assets ingested before dedupe existed. */
async function backfillContentHashes() {
  const rows = db.prepare("SELECT id, user_id, original_path FROM assets WHERE content_hash IS NULL AND media_type = 'image'").all() as
    Array<{ id: string; user_id: string; original_path: string }>;
  if (!rows.length) return;
  let updated = 0;
  for (const row of rows) {
    try {
      const hash = await sha256File(path.join(dataDir, row.original_path));
      db.prepare("UPDATE assets SET content_hash = ? WHERE id = ?").run(hash, row.id);
      updated += 1;
    } catch {
      // Pre-existing duplicate or unreadable file — leave NULL so it never blocks anything.
    }
  }
  console.log(`Backfilled content hashes for ${updated}/${rows.length} assets.`);
}

/**
 * One-time migration to WebP-only storage: assets ingested before this change
 * still have a stored original (original_path differs from preview_path).
 * Re-encode the preview at 2048px from that original, then delete it.
 * Must run after backfillContentHashes so hashes reflect the uploaded bytes.
 */
async function migrateOriginalsToWebp() {
  const rows = db.prepare("SELECT * FROM assets WHERE original_path <> preview_path AND media_type = 'image'").all() as AssetRow[];
  if (!rows.length) return;
  console.log(`Migrating ${rows.length} asset(s) to WebP-only storage...`);
  let migrated = 0;
  for (const row of rows) {
    try {
      const absoluteOriginal = path.join(dataDir, row.original_path);
      const absolutePreview = path.join(dataDir, row.preview_path);
      const hasOriginal = await fs.access(absoluteOriginal).then(() => true, () => false);
      if (hasOriginal) {
        // Write to a temp name first so a crash mid-encode can't corrupt the
        // preview that's currently being served.
        const tempPath = `${absolutePreview}.tmp`;
        const info = await sharp(absoluteOriginal)
          .rotate()
          .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(tempPath);
        await fs.rename(tempPath, absolutePreview);
        db.prepare(`
          UPDATE assets
          SET original_path = preview_path, mime_type = 'image/webp', size_bytes = ?, width = ?, height = ?
          WHERE id = ?
        `).run(info.size, info.width ?? null, info.height ?? null, row.id);
        await fs.rm(absoluteOriginal, { force: true });
      } else {
        const stat = await fs.stat(absolutePreview).catch(() => null);
        db.prepare(`
          UPDATE assets
          SET original_path = preview_path, mime_type = 'image/webp', size_bytes = COALESCE(?, size_bytes)
          WHERE id = ?
        `).run(stat?.size ?? null, row.id);
      }
      migrated += 1;
    } catch (error) {
      console.error(`WebP migration failed for asset ${row.id}:`, error);
    }
  }
  console.log(`WebP migration finished for ${migrated}/${rows.length} asset(s).`);
}

/** Download filename for an asset: the uploaded name with a .webp extension. */
function webpDownloadName(originalName: string) {
  const ext = path.extname(originalName);
  const base = ext ? originalName.slice(0, originalName.length - ext.length) : originalName;
  return `${base || "photo"}.webp`;
}

function videoDownloadName(originalName: string) {
  const ext = path.extname(originalName);
  const base = ext ? originalName.slice(0, originalName.length - ext.length) : originalName;
  return `${base || "video"}.mp4`;
}

function sendAssetFile(res: express.Response, relPath: string) {
  // Variant files never change for a given asset id, so they can be cached hard.
  res.sendFile(
    path.join(dataDir, relPath),
    { headers: { "Cache-Control": "private, max-age=31536000, immutable" } },
    (error) => {
      if (error && !res.headersSent) {
        res.status(404).json({ error: "File not found." });
      }
    }
  );
}

function findOwnedAsset(assetId: string, user: PublicUser) {
  return db.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?").get(assetId, user.id) as AssetRow | undefined;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: Boolean(row.disabled),
    createdAt: row.created_at
  };
}

function toPublicAlbum(row: AlbumRow) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    assetCount: row.asset_count ?? 0,
    coverAssetId: row.cover_asset_id ?? null,
    shareToken: row.share_token,
    shareUrl: row.share_token ? `/share/${row.share_token}` : null
  };
}

/** Asset ids that belong to at least one of the user's shared (token-bearing) albums. */
function sharedAlbumAssetIds(userId: string): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT album_assets.asset_id AS id
    FROM album_assets
    JOIN albums ON albums.id = album_assets.album_id
    WHERE albums.user_id = ? AND albums.share_token IS NOT NULL
  `).all(userId) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Whether a single asset is in any of the user's shared albums. */
function assetInSharedAlbum(userId: string, assetId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM album_assets
    JOIN albums ON albums.id = album_assets.album_id
    WHERE album_assets.asset_id = ? AND albums.user_id = ? AND albums.share_token IS NOT NULL
    LIMIT 1
  `).get(assetId, userId);
  return Boolean(row);
}

function toPublicAsset(row: AssetRow, shareToken?: string, inSharedAlbum = false) {
  const base = shareToken ? `/api/share/${shareToken}/file/${row.id}` : `/api/assets/${row.id}/file`;
  const isVideo = row.media_type === "video";
  const ready = isVideo && row.status === "ready";
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    takenAt: row.taken_at,
    createdAt: row.created_at,
    favorite: Boolean(row.favorite),
    archived: Boolean(row.archived),
    trashed: Boolean(row.trashed),
    inSharedAlbum,
    mediaType: isVideo ? "video" : "image",
    status: row.status ?? "ready",
    durationMs: row.duration_ms ?? null,
    urls: {
      thumb: `${base}/thumb`,
      preview: `${base}/preview`,
      original: shareToken ? null : `${base}/original`,
      video: ready ? `${base}/video` : null,
      videoSd: ready ? `${base}/video_sd` : null
    }
  };
}
