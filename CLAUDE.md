# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (runs server on :4000 and Vite on :5173 concurrently)
npm run dev

# Individual processes
npm run dev:server   # Express server with tsx watch
npm run dev:web      # Vite dev server (proxies /api to :4000)

# Production build
npm run build        # Compiles server (tsc) + client (vite) into dist-server/ and dist-client/
npm start            # Runs the compiled server

# Type checking (both client and server)
npm run typecheck
```

There are no tests. Type checking is the only automated correctness check.

## Architecture

This is a single-repo fullstack photo management app with two separate TypeScript compilation units:

**Server** (`src/server/index.ts`) — single-file Express 5 app compiled with `tsconfig.server.json` (NodeNext modules) to `dist-server/`. It uses Node's built-in `node:sqlite` (`DatabaseSync`) — no ORM, no migration framework, just inline SQL with schema creation and `ensureColumn()` for additive migrations. All business logic, auth, and file handling live in this one file.

**Client** (`src/client/main.tsx`) — single-file React 19 SPA compiled by Vite to `dist-client/`. All components, state, and API calls are in this one file. No routing library; view switching is handled by a `View` state enum. The `api<T>()` helper at the bottom wraps `fetch` with JSON error handling.

In production, the Express server serves `dist-client/` as static files and catches all non-API routes with an `index.html` fallback (SPA pattern). In development, Vite proxies `/api/*` to Express on `:4000`.

**Data layer:**
- SQLite database at `DATA_DIR/photos.sqlite` (default `./data/photos.sqlite`)
- Uploaded originals, previews (1800px WebP), and thumbnails (560px WebP) stored under `DATA_DIR/uploads/<userId>/<assetId>/`
- `sharp` handles image processing and EXIF auto-rotation on ingest
- `multer` handles multipart uploads, staging files in `DATA_DIR/tmp/` before `ingestAsset()` moves them

**Auth:** Cookie-based sessions (`sjodin_session`). Passwords hashed with PBKDF2-SHA256 (310,000 iterations). Sessions stored in SQLite. Two roles: `admin` and `user`. The `requireAuth` middleware attaches the user to the request; `requireAdmin` gates admin routes.

**Shared albums:** Albums can have an optional `share_token`; the `/share/:token` routes serve album contents without authentication. File variants served via `/api/share/:token/file/:assetId/:variant` (thumb/preview only — no original for public access).

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Server port |
| `DATA_DIR` | `./data` | Root for SQLite DB and uploads |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Upserts an admin on startup if both are set |
| `MAX_UPLOAD_FILES` | `500` | Max files per upload request |
| `MAX_UPLOAD_FILE_SIZE_MB` | `120` | Max file size per upload |

If no users exist and `ADMIN_EMAIL`/`ADMIN_PASSWORD` are not set, a dev admin `admin@example.com` / `change-me-before-deploy` is created.

## Docker

```bash
docker build -t sjodin-photos .
docker run -p 4000:4000 -v /host/data:/app/data sjodin-photos
```

The `data/` volume holds both the SQLite database and all uploaded files — it must be persisted across container restarts.
