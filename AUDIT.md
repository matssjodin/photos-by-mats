# Production-Readiness Audit — Sjodin Photos

Date: 2026-06-10. Auditor: Claude Code.

## What this project is

A private, self-hosted Google Photos-style app for the Sjödin family. Single repo, two
compilation units: an Express 5 + `node:sqlite` server (`src/server/index.ts`, one file)
and a React 19 SPA built by Vite (`src/client/main.tsx`, one file). Deployed via Docker
(Coolify) at photos.matssjodin.com with an embedded SQLite DB and disk storage under a
persistent `/app/data` volume. Audience: a handful of trusted users created by an admin;
public exposure is limited to unauthenticated album share links.

"Production-grade" here means: secure against the open internet, no data loss, reliable
under family-scale load (thousands of photos, a few users) — not horizontal scale.

## Verification status (Phase 1)

- `npm run typecheck` — PASS (client + server, strict mode already on)
- `npm run build` — PASS (223 KB JS / 69.6 KB gzip)
- Compiled server boots against a fresh DATA_DIR; `/api/health` 200; dev-admin login 200
- `npm audit --omit=dev` — 0 vulnerabilities
- `npm audit` (with dev) — 2 critical via `shell-quote` < `concurrently` (dev-only)
- No tests exist (per CLAUDE.md, typecheck is the only check)

## Domain applicability matrix

| Domain | Applies? | Notes |
|---|---|---|
| Architecture | Yes | Single-file server + single-file client is intentional and fits the scale |
| Security | Yes | Internet-facing auth app handling private photos |
| Data layer | Yes | SQLite, inline SQL, additive migrations |
| API design | Yes (internal) | Private API consumed only by its own SPA + share links |
| Performance | Yes | Image-heavy app |
| Reliability | Yes | Docker deploy, restarts, uploads |
| UX/UI | Yes | Already polished; gaps noted |
| Business & conversion | **No** | Private family app. No SEO/analytics/payments/legal pages needed. Marked noindex instead. |
| Code quality & testing | Yes | No tests at all |
| DevOps & infra | Yes | Docker + Coolify; no CI |
| Documentation | Yes | README/CLAUDE.md good, minor drift |
| i18n | No | Single-family audience, English UI is fine |

## Findings

Severity: CRITICAL / HIGH / MEDIUM / LOW. Status: FIXED / BACKLOG / DECISION (needs owner input).

### Security

| # | Sev | Finding | Status |
|---|---|---|---|
| S1 | CRITICAL (dev-only) | `shell-quote` 1.8.x vulnerability via `concurrently` (GHSA-w7jw-789q-3m8p). Dev dependency only — not in the production image (`npm ci --omit=dev`), but flagged critical and trivially fixable. | FIXED |
| S2 | MEDIUM | No security headers: missing `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`, `HSTS` (prod), CSP. Especially relevant because originals are stored with their client-supplied extension and the upload filter trusts the client MIME type (mitigated today by `Content-Disposition: attachment` on originals and sharp failing on non-images, but nosniff/CSP is the proper backstop). | FIXED |
| S3 | LOW | Upload `fileFilter` trusts client-declared `image/*` MIME. Sharp's ingest fails (and cleans up) for non-images, so junk can't become browsable assets; original variant is download-only. Defense-in-depth covered by S2 headers. | Accepted (documented) |
| S4 | LOW | Login rate limiting is in-memory per-IP (resets on restart, keyed on `X-Forwarded-For` with `trust proxy 1`). Adequate for this scale. | Accepted |
| S5 | — | Checked for IDOR: every asset/album route filters by `user_id`; share routes serve thumb/preview only, never originals; share tokens are 144-bit random. No issues found. | n/a |
| S6 | — | Passwords PBKDF2-SHA256/310k with per-user salt, timing-safe compare, dummy-hash on unknown user (no user enumeration timing). Sessions are 256-bit tokens, HttpOnly, SameSite=Lax, Secure in prod, server-side in SQLite, expiry enforced + hourly cleanup. CSRF via Origin/Referer check incl. APP_ORIGIN. Good. | n/a |
| S7 | — | Git history checked conceptually: no secrets in repo; `.env` gitignored; `.env.example` contains only documented dev defaults. Production refuses to start without ADMIN_EMAIL/ADMIN_PASSWORD when no users exist. | n/a |
| S8 | LOW | Shared previews/thumbs are sharp-regenerated WebP, which strips EXIF (incl. GPS) — good. Originals (with EXIF) are owner-only. | n/a |

### Data layer

| # | Sev | Finding | Status |
|---|---|---|---|
| D1 | MEDIUM | No indexes beyond PKs/uniques: `assets` is scanned per user query; `sessions.expires_at` and `album_assets.asset_id` unindexed. Cheap additive fix. | FIXED |
| D2 | LOW | `DELETE /api/assets/:id` removes the DB row before the files; a crash in between leaves orphan files (never the reverse, so no broken UI). Album-upload rollback path deletes the asset row but not its files. Disk-orphan risk only. | BACKLOG (low) |
| D3 | LOW | No backup tooling. SQLite in WAL mode + file uploads on one volume makes backup easy (stop-free `sqlite3 .backup` or volume snapshot) but nothing is automated. | DECISION (host-level) |
| D4 | — | Schema has FKs with ON DELETE CASCADE, CHECK on role, UNIQUE on email/share_token; `ensureColumn()` handles additive migration. Appropriate for scale. | n/a |

### API design

| # | Sev | Finding | Status |
|---|---|---|---|
| A1 | MEDIUM | No pagination on `/api/assets` (or share albums) — the entire library is returned as one JSON array. Fine into the thousands of photos; will degrade past ~10k. Needs coordinated client work (infinite scroll). | BACKLOG |
| A2 | LOW | Consistent `{ error }` JSON shape, sensible status codes, no internals leaked. No versioning — appropriate for a private API. | n/a |
| A3 | LOW | `sendFile` on a missing file produced a 500; should be 404. | FIXED |

### Performance

| # | Sev | Finding | Status |
|---|---|---|---|
| P1 | MEDIUM | No `Cache-Control` on image variants. Thumbs/previews are immutable per asset id; browsers re-validate every grid render. Adding `private, max-age=31536000, immutable` removes most repeat traffic. | FIXED |
| P2 | LOW | Upload ingest is CPU-bound sharp work limited by `INGEST_CONCURRENCY` (default 3) — already sensible. | n/a |
| P3 | LOW | Bundle 70 KB gzip, thumbnails lazy-loaded, WebP variants. Good. | n/a |

### Reliability

| # | Sev | Finding | Status |
|---|---|---|---|
| R1 | MEDIUM | No graceful shutdown: SIGTERM (every Docker redeploy) hard-kills in-flight uploads and leaves the SQLite WAL un-checkpointed. | FIXED |
| R2 | LOW | `DATA_DIR/tmp` staging files can accumulate after crashes mid-upload; never cleaned. | FIXED (startup sweep) |
| R3 | — | Health check endpoint + Docker HEALTHCHECK exist. Multer/ingest failure paths clean up staged and partial files. Error middleware doesn't leak stack traces. | n/a |

### UX / UI

| # | Sev | Finding | Status |
|---|---|---|---|
| U1 | MEDIUM | **Bug:** pressing Enter in the search box while inside an album fetches the whole photo library into the album view (`/api/assets?view=albums` falls through to the photos view). Client-side filtering is also disabled inside albums. Search inside an album is broken in both directions. | FIXED |
| U2 | MEDIUM | Admin panel `updateUser`/role/disable actions have no error handling — a failed request rejects unhandled with zero UI feedback. | FIXED |
| U3 | LOW | No favicon, no meta description; private app should also be `noindex`. | FIXED |
| U4 | LOW | If the session expires while the tab is open, API calls fail with toast errors instead of returning to the login screen. | FIXED (auto-return to login on 401) |
| U5 | LOW | Album-cover star on tiles is a `span role="button"` nested in a button — not keyboard accessible. Several icon buttons rely on `title` only (acceptable; titles present). | FIXED (2026-06-10 frontend rebuild: keyboard handler + visible on touch) |
| U6 | LOW | Long-press to multi-select is 3000 ms — unusually long (platform norm ~500 ms). | FIXED (2026-06-10 frontend rebuild: 500 ms + movement tolerance + explicit Select button) |
| U8 | — | 2026-06-10: frontend rebuilt mobile-first at owner's request. Viewer rebuilt on a portal + flexbox stage (root-causes the repeated mobile-centering bug), swipe gestures, bottom tab bar, bottom-sheet info/modals, safe-area insets, iOS input-zoom fix, body scroll locking. Verified via `scripts/visual-check.mjs` headless-Edge screenshots. | DONE |
| U7 | — | Loading skeletons, empty states, error states, confirm dialogs, drag-drop, keyboard nav in viewer all present. UI quality is high. | n/a |

### Code quality & testing

| # | Sev | Finding | Status |
|---|---|---|---|
| Q1 | HIGH | Zero automated tests. Auth, ownership checks, share gating, and upload ingest are exactly the things that must not regress silently. | FIXED (smoke/integration suite via `node:test`, no new deps) |
| Q2 | LOW | TypeScript strict mode already enabled in both units; no dead code or TODOs found; consistent style. | n/a |
| Q3 | LOW | No linter configured. Typecheck + tests cover correctness; a linter is polish here. | BACKLOG |

### DevOps & infrastructure

| # | Sev | Finding | Status |
|---|---|---|---|
| O1 | HIGH | No CI. Nothing runs typecheck/build/tests before deploy (Coolify builds on push to main). | FIXED (GitHub Actions) |
| O2 | MEDIUM | Container runs as **root**. Should be `USER node`, but the existing production volume's files are owned by root — flipping this without a one-time `chown` on the volume would break the live deployment. **Not changed; needs owner action.** See Recommendations. | DECISION |
| O3 | — | Multi-stage Dockerfile, prod-only deps in runtime image, HEALTHCHECK, .dockerignore — all good. | n/a |

### Documentation

| # | Sev | Finding | Status |
|---|---|---|---|
| C1 | LOW | `.env.example` and CLAUDE.md env table miss `INGEST_CONCURRENCY` and `APP_ORIGIN` (CLAUDE.md); CLAUDE.md says "there are no tests" — now stale once tests land. | FIXED |

## Fix plan / order

1. ~~S1 npm audit fix~~ → commit
2. ~~S2 + P1 + A3 server headers/caching/404~~ → commit
3. ~~D1 + R1 + R2 indexes, shutdown, tmp sweep~~ → commit
4. ~~U1 + U2 + U4 client fixes~~ → commit
5. ~~U3 index.html polish~~ → commit
6. ~~Q1 test suite + npm test~~ → commit
7. ~~O1 CI workflow~~ → commit
8. ~~C1 docs~~ → commit

## Items explicitly left for the owner (DECISION)

- **O2 non-root container**: requires a one-time `chown -R 1000:1000` of the production
  data volume during a maintenance window. Dockerfile change is 3 lines once that's done.
- **D3 backups**: needs a host-side decision (volume snapshots vs. scheduled `sqlite3 .backup`
  + rsync of uploads). Nothing in-repo can substitute for an off-host copy.
- **A1 pagination**: behavior-changing client+server work; not needed at current library size.
- **U6 long-press duration**: 3 s appears deliberate; say the word and it becomes 500 ms.
