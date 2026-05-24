# Sjodin Photos

A private, self-hosted Google Photos-style app. It has server-side accounts, admin-only user creation, local disk photo storage, generated browsing previews, albums, favorites, archive, trash, drag-and-drop uploads, random share links for albums, and a responsive modern UI.

## Local Development

```bash
npm install
npm run dev
```

Frontend: <http://localhost:5173>  
API: <http://localhost:4000>

On startup, the server ensures the account from `ADMIN_EMAIL` and `ADMIN_PASSWORD` exists, is enabled, has admin access, and has that password. In development, if no users exist and those variables are missing, it falls back to:

- Email: `admin@example.com`
- Password: `change-me-before-deploy`

## Coolify Deployment

Deploy this repository as a Docker app and set these environment variables:

```bash
PORT=4000
DATA_DIR=/app/data
SESSION_SECRET=<long random secret>
ADMIN_EMAIL=<your admin email>
ADMIN_PASSWORD=<your first admin password>
```

Mount persistent storage to `/app/data`. Originals, generated previews, thumbnails, and the SQLite database all live there.

There is no public sign-up route. New users are created from the in-app Admin screen.

If you change `ADMIN_EMAIL` or `ADMIN_PASSWORD` after the app has already created its database, redeploy or restart the container. The configured admin account is reconciled during server startup.

Individual photo file routes require authentication. Public sharing is album-only through random `/share/<token>` links; shared viewers can browse album previews without receiving direct original-file URLs.
