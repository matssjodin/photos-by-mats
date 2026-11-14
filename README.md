# Sjodin Photos

A private, self-hosted Google Photos-style app — a single lightweight container with an embedded SQLite database and local disk storage. The product name is configurable, so it can be deployed as a white-label photo service (see [White-label branding](#white-label-branding)).

## Features

**Library**

- Drag-and-drop or picker uploads with a combined progress bar; large batches are automatically split into requests that stay under proxy limits (e.g. Cloudflare's 100 MB cap)
- Photos are stored as two WebP variants per image — a 2048 px (longer side) display version and a 560 px thumbnail. The uploaded original is converted and discarded, keeping storage small
- SHA-256 duplicate detection: re-uploading the same source file is skipped (or restores it from the trash) instead of being stored twice
- EXIF capture date and auto-rotation are applied on ingest; the library is grouped by day
- Favorites, archive, and trash views; trashed photos are purged permanently after a configurable retention period
- Search by filename or date
- Bulk select (long-press on touch) with add-to-album, favorite, archive, zip download, and trash

**Albums**

- Albums with cover photos and per-day "select whole day" picking when adding existing photos
- Rename or delete an album, with an optional checkbox to move all of its photos to the trash at the same time
- Public sharing via unguessable `/share/<token>` links — viewers see thumbnails and display versions only, never originals, and tokens can be revoked

**Viewer**

- Instant-open blurred placeholder, then the full preview
- Swipe left/right to navigate, swipe down to close, pinch or double-tap to zoom and pan
- Subtle on-screen arrows for click/tap navigation (desktop and touch)
- Keyboard navigation (arrow keys, Escape) on desktop
- Info panel with date, size, dimensions, and download

**App platform**

- Installable PWA: offline shell, standalone window, and an Android share-target — sharing photos from the system share sheet uploads them straight into the library
- Hardware/browser back button closes the viewer, album, or modal instead of leaving the app
- Mobile-first responsive UI (bottom tab bar on phones, sidebar on desktop)

**Accounts and security**

- Cookie-based sessions, PBKDF2-hashed passwords, login rate limiting
- Two roles: `admin` and `user`; new users are created from the in-app Admin screen (no public sign-up)
- CSRF origin guard, strict security headers and CSP, per-user file authorization on every photo route

## Local development

```bash
npm install
npm run dev
```

Frontend: <http://localhost:5173> (Vite, proxies `/api` to the server)
API: <http://localhost:4000>

```bash
npm run typecheck   # Type checking for client and server
npm test            # Smoke/integration tests (boots the real server against a temp DATA_DIR)
npm run build       # Production build into dist-server/ and dist-client/
npm start           # Run the compiled server
```

CI runs typecheck, build, tests, and a production-dependency audit on every push and pull request (`.github/workflows/ci.yml`).

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` for local use.

### Core

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Server port |
| `DATA_DIR` | `./data` | Root for the SQLite database and all photo files |
| `APP_ORIGIN` | — | Public origin the browser hits (e.g. `https://photos.example.com`). The CSRF guard accepts requests from this origin |
| `TRUST_PROXY` | `1` | Number of reverse proxies in front of the app (Express `trust proxy` hop count). Decides which `X-Forwarded-For` entry counts as the client IP for login rate limiting — e.g. `2` behind Cloudflare + Coolify's proxy. Too high lets clients spoof their IP |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | The admin account, reconciled on every startup (created, enabled, made admin, password set) |

On startup the server ensures the `ADMIN_EMAIL`/`ADMIN_PASSWORD` account exists and matches. In development, if no users exist and those variables are missing, it creates `admin@example.com` / `change-me-before-deploy`. In production the server **refuses to start** with no users and no admin variables — it never creates a default account.

### White-label branding

The product name is not hard-coded. Set these to rebrand the whole app — UI, login screen, shared album pages, browser tab title, and the installable PWA — without touching the code:

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `Sjodin Photos` | Display name shown in the sidebar, login screen, shared pages, page title, and PWA manifest |
| `APP_SHORT_NAME` | `Photos` | Short label under the home-screen icon when installed as a PWA |
| `ATTRIBUTION_TEXT` | `Photoalbum by Mats Sjödin` | Subtle footer link on shared album pages. Set to an empty string to hide the footer |
| `ATTRIBUTION_URL` | `https://matssjodin.com` | Where the footer link points |

To complete a rebrand, also replace the icons in `public/icons/` (or regenerate them with `node scripts/make-icons.mjs`).

### Tuning

| Variable | Default | Purpose |
|---|---|---|
| `MAX_UPLOAD_FILES` | `500` | Max files per upload request |
| `MAX_UPLOAD_FILE_SIZE_MB` | `120` | Max size per uploaded file |
| `INGEST_CONCURRENCY` | `3` | Parallel image-processing workers during upload ingest (CPU-bound — lower it on small servers) |
| `TRASH_RETENTION_DAYS` | `30` | Days before trashed photos are permanently purged (`0` disables auto-purge) |

## Deployment

### Coolify (or any Docker host)

Deploy the repository as a Docker app. The database is embedded SQLite — no separate database service is needed.

```bash
PORT=4000
DATA_DIR=/app/data
ADMIN_EMAIL=<your admin email>
ADMIN_PASSWORD=<your first admin password>
APP_ORIGIN=https://photos.example.com
APP_NAME=Sjodin Photos
APP_SHORT_NAME=Photos
```

Mount persistent storage at `/app/data`. The SQLite database and every photo live there:

```text
/app/data/photos.sqlite
/app/data/uploads/
```

**Do not deploy without persistent storage** — recreating the container would otherwise erase all users, albums, and photos.

### Docker Compose

```bash
cp .env.example .env     # set DATA_DIR=/app/data for containers
docker compose up -d --build
```

### Reverse proxies and Cloudflare

The app works behind any reverse proxy. Two practical notes:

- The Node server keeps idle keep-alive connections open for 185 s so it never closes a pooled connection before the proxy does.
- Behind Cloudflare's proxy, requests are subject to Cloudflare's 100 MB body limit (the upload UI batches below this automatically) and origin-fetch latency depends on the Cloudflare-to-host network path. If shared albums load slowly through Cloudflare while the origin is fast, consider a DNS-only (gray-cloud) record for the photos hostname.

## Storage model

Each photo is stored under `DATA_DIR/uploads/<userId>/<assetId>/` as exactly two files:

- `preview.webp` — max 2048 px on the longer side, what viewers and downloads receive
- `thumb.webp` — 560 px square-ish thumbnail for grids

Uploaded originals are discarded after conversion (keep your master copies elsewhere). Duplicate detection still works across re-uploads because the content hash is computed from the uploaded bytes before conversion.
