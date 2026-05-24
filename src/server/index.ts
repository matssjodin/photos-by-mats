import cookie from "cookie";
import express from "express";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

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
  original_path: string;
  preview_path: string;
  thumb_path: string;
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
const upload = multer({
  dest: tempDir,
  limits: {
    fileSize: 1024 * 1024 * maxUploadFileSizeMb,
    files: maxUploadFiles
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image files can be uploaded."));
  }
});

await fs.mkdir(uploadsDir, { recursive: true });
await fs.mkdir(tempDir, { recursive: true });

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
ensureAdminAccount();

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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
    ORDER BY album_assets.added_at DESC
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
  if (!album || (variant !== "thumb" && variant !== "preview")) {
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

  res.sendFile(path.join(dataDir, variant === "thumb" ? asset.thumb_path : asset.preview_path));
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const user = db
    .prepare("SELECT * FROM users WHERE lower(email) = lower(?)")
    .get(email.trim()) as UserRow | undefined;

  if (!user || user.disabled || !verifyPassword(password, user.salt, user.password_hash)) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionTtlMs;
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(token, user.id, expiresAt, new Date().toISOString());

  res.setHeader("Set-Cookie", cookie.serialize(sessionCookie, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
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
    secure: process.env.NODE_ENV === "production",
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
  db.prepare("DELETE FROM users WHERE id = ?").run(existing.id);
  await fs.rm(userAssetDir, { recursive: true, force: true });
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

  res.json({ assets: assets.map((asset) => toPublicAsset(asset)) });
});

app.post("/api/assets", upload.array("photos", maxUploadFiles), async (req, res, next) => {
  try {
    const user = authUser(req);
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) {
      res.status(400).json({ error: "No image files were uploaded." });
      return;
    }

    const created: ReturnType<typeof toPublicAsset>[] = [];
    for (const file of files) {
      created.push(await ingestAsset(user.id, file));
    }

    res.status(201).json({ assets: created });
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
  const relPath = variant === "original"
    ? asset.original_path
    : variant === "preview"
      ? asset.preview_path
      : variant === "thumb"
        ? asset.thumb_path
        : "";

  if (!relPath) {
    res.status(404).json({ error: "Variant not found." });
    return;
  }
  res.sendFile(path.join(dataDir, relPath));
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

  db.prepare(`
    UPDATE assets
    SET favorite = ?, archived = ?, trashed = ?
    WHERE id = ?
  `).run(
    typeof favorite === "boolean" ? Number(favorite) : asset.favorite,
    typeof archived === "boolean" ? Number(archived) : asset.archived,
    typeof trashed === "boolean" ? Number(trashed) : asset.trashed,
    asset.id
  );

  const updated = db.prepare("SELECT * FROM assets WHERE id = ?").get(asset.id) as AssetRow;
  res.json({ asset: toPublicAsset(updated) });
});

app.delete("/api/assets/:id", async (req, res) => {
  const user = authUser(req);
  const asset = findOwnedAsset(String(req.params.id), user);
  if (!asset) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }

  db.prepare("DELETE FROM assets WHERE id = ?").run(asset.id);
  await fs.rm(path.dirname(path.join(dataDir, asset.original_path)), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get("/api/albums", (req, res) => {
  const user = authUser(req);
  const albums = db.prepare(`
    SELECT albums.*,
      COUNT(album_assets.asset_id) AS asset_count,
      (
        SELECT assets.id FROM album_assets aa
        JOIN assets ON assets.id = aa.asset_id
        WHERE aa.album_id = albums.id AND assets.trashed = 0
        ORDER BY aa.added_at DESC LIMIT 1
      ) AS cover_asset_id
    FROM albums
    LEFT JOIN album_assets ON album_assets.album_id = albums.id
    WHERE albums.user_id = ?
    GROUP BY albums.id
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
  const album = db.prepare("SELECT * FROM albums WHERE id = ?").get(id) as AlbumRow;
  res.status(201).json({ album: toPublicAlbum(album) });
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

    const created: ReturnType<typeof toPublicAsset>[] = [];
    for (const file of files) {
      const asset = await ingestAsset(user.id, file);
      db.prepare("INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, ?)")
        .run(albumId, asset.id, new Date().toISOString());
      created.push(asset);
    }

    res.status(201).json({ assets: created });
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
    ORDER BY album_assets.added_at DESC
  `).all(albumId) as AssetRow[];
  res.json({ assets: assets.map((asset) => toPublicAsset(asset)) });
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
  const updated = db.prepare("SELECT * FROM albums WHERE id = ?").get(albumId) as AlbumRow;
  res.json({ album: toPublicAlbum(updated) });
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
  const updated = db.prepare("SELECT * FROM albums WHERE id = ?").get(albumId) as AlbumRow;
  res.json({ album: toPublicAlbum(updated) });
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
  db.prepare("DELETE FROM albums WHERE id = ?").run(albumId);
  res.json({ ok: true });
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
  if (error instanceof Error && error.message === "Only image files can be uploaded.") {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(port, () => {
  console.log(`Sjodin Photos is running on port ${port}`);
});

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

async function ingestAsset(userId: string, file: Express.Multer.File) {
  const id = crypto.randomUUID();
  const ext = extensionFor(file.originalname, file.mimetype);
  const relativeDir = path.join("uploads", userId, id);
  const absoluteDir = path.join(dataDir, relativeDir);
  await fs.mkdir(absoluteDir, { recursive: true });

  const originalPath = path.join(relativeDir, `original${ext}`);
  const previewPath = path.join(relativeDir, "preview.webp");
  const thumbPath = path.join(relativeDir, "thumb.webp");
  const absoluteOriginal = path.join(dataDir, originalPath);
  await fs.rename(file.path, absoluteOriginal);

  const image = sharp(absoluteOriginal).rotate();
  const metadata = await image.metadata();
  await sharp(absoluteOriginal)
    .rotate()
    .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(path.join(dataDir, previewPath));
  await sharp(absoluteOriginal)
    .rotate()
    .resize({ width: 560, height: 560, fit: "cover", position: "attention" })
    .webp({ quality: 76 })
    .toFile(path.join(dataDir, thumbPath));

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO assets (
      id, user_id, original_name, mime_type, size_bytes, width, height,
      taken_at, created_at, original_path, preview_path, thumb_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    file.originalname,
    file.mimetype,
    file.size,
    metadata.width ?? null,
    metadata.height ?? null,
    now,
    now,
    originalPath,
    previewPath,
    thumbPath
  );

  const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow;
  return toPublicAsset(row);
}

function extensionFor(filename: string, mimeType: string) {
  const ext = path.extname(filename).toLowerCase();
  if (ext && ext.length <= 8) return ext;
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/avif") return ".avif";
  return ".jpg";
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

function toPublicAsset(row: AssetRow, shareToken?: string) {
  const base = shareToken ? `/api/share/${shareToken}/file/${row.id}` : `/api/assets/${row.id}/file`;
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
    urls: {
      thumb: `${base}/thumb`,
      preview: `${base}/preview`,
      original: shareToken ? null : `${base}/original`
    }
  };
}
