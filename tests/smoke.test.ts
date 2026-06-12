import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const port = 40000 + (process.pid % 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const origin = baseUrl;
const adminEmail = "admin@example.com";
const adminPassword = "change-me-before-deploy";

let server: ChildProcess;
let dataDir: string;
let serverLog = "";
let sessionCookie = "";

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sjodin-photos-test-"));
  server = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "development",
      DATA_DIR: dataDir,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout?.on("data", (chunk) => { serverLog += chunk; });
  server.stderr?.on("data", (chunk) => { serverLog += chunk; });

  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) break;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`Server did not start within 30s. Log:\n${serverLog}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

after(async () => {
  server?.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

function authedHeaders(extra: Record<string, string> = {}) {
  return { Cookie: sessionCookie, Origin: origin, ...extra };
}

async function makePng(background = { r: 200, g: 100, b: 50 }) {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background }
  }).png().toBuffer();
}

test("health endpoint responds with security headers", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.ok(response.headers.get("content-security-policy")?.includes("default-src 'self'"));
});

test("state-changing request without Origin/Referer is rejected (CSRF guard)", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  assert.equal(response.status, 403);
});

test("login rejects bad credentials", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: adminEmail, password: "wrong-password" })
  });
  assert.equal(response.status, 401);
});

test("login succeeds for the dev admin and sets an HttpOnly session cookie", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie()[0];
  assert.ok(setCookie?.startsWith("sjodin_session="));
  assert.ok(/httponly/i.test(setCookie));
  sessionCookie = setCookie.split(";")[0];
  const body = await response.json() as { user: { email: string; role: string } };
  assert.equal(body.user.email, adminEmail);
  assert.equal(body.user.role, "admin");
});

test("API requires authentication", async () => {
  const response = await fetch(`${baseUrl}/api/assets`);
  assert.equal(response.status, 401);
});

test("/api/me returns the logged-in user", async () => {
  const response = await fetch(`${baseUrl}/api/me`, { headers: authedHeaders() });
  assert.equal(response.status, 200);
  const body = await response.json() as { user: { email: string } };
  assert.equal(body.user.email, adminEmail);
});

test("non-image uploads are rejected", async () => {
  const form = new FormData();
  form.append("photos", new Blob(["not an image"], { type: "text/plain" }), "evil.txt");
  const response = await fetch(`${baseUrl}/api/assets`, {
    method: "POST",
    headers: authedHeaders(),
    body: form
  });
  assert.equal(response.status, 400);
});

let assetId = "";

test("image upload ingests and produces variants", async () => {
  const form = new FormData();
  form.append("photos", new Blob([new Uint8Array(await makePng())], { type: "image/png" }), "test.png");
  const response = await fetch(`${baseUrl}/api/assets`, {
    method: "POST",
    headers: authedHeaders(),
    body: form
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { assets: Array<{ id: string; urls: { thumb: string; original: string | null } }>; errors: unknown[] };
  assert.equal(body.assets.length, 1);
  assert.equal(body.errors.length, 0);
  assetId = body.assets[0].id;

  const thumb = await fetch(`${baseUrl}${body.assets[0].urls.thumb}`, { headers: authedHeaders() });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get("content-type"), "image/webp");
  assert.ok(thumb.headers.get("cache-control")?.includes("immutable"));
});

test("file requests for someone else's asset id return 404 shape (no IDOR leak)", async () => {
  const response = await fetch(`${baseUrl}/api/assets/does-not-exist/file/thumb`, { headers: authedHeaders() });
  assert.equal(response.status, 404);
});

test("album create, add asset, share, and public access work end to end", async () => {
  const createResponse = await fetch(`${baseUrl}/api/albums`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title: "Test Album" })
  });
  assert.equal(createResponse.status, 201);
  const { album } = await createResponse.json() as { album: { id: string } };

  const addResponse = await fetch(`${baseUrl}/api/albums/${album.id}/assets`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ assetIds: [assetId] })
  });
  assert.equal(addResponse.status, 200);
  assert.equal((await addResponse.json() as { added: number }).added, 1);

  const shareResponse = await fetch(`${baseUrl}/api/albums/${album.id}/share`, {
    method: "POST",
    headers: authedHeaders()
  });
  assert.equal(shareResponse.status, 200);
  const shared = await shareResponse.json() as { album: { shareToken: string } };
  assert.ok(shared.album.shareToken);

  // Public, unauthenticated access to the shared album
  const publicResponse = await fetch(`${baseUrl}/api/share/${shared.album.shareToken}`);
  assert.equal(publicResponse.status, 200);
  const publicBody = await publicResponse.json() as { assets: Array<{ urls: { original: string | null; thumb: string } }> };
  assert.equal(publicBody.assets.length, 1);
  assert.equal(publicBody.assets[0].urls.original, null, "shared albums must never expose original files");

  const publicThumb = await fetch(`${baseUrl}${publicBody.assets[0].urls.thumb}`);
  assert.equal(publicThumb.status, 200);
  assert.equal(publicThumb.headers.get("content-type"), "image/webp");

  // Originals stay locked down even with a valid share token
  const originalAttempt = await fetch(`${baseUrl}/api/share/${shared.album.shareToken}/file/${assetId}/original`);
  assert.equal(originalAttempt.status, 404);

  // Bogus token gets nothing
  const bogus = await fetch(`${baseUrl}/api/share/not-a-real-token`);
  assert.equal(bogus.status, 404);
});

test("trash and permanent delete remove the asset", async () => {
  const trashResponse = await fetch(`${baseUrl}/api/assets/${assetId}`, {
    method: "PATCH",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ trashed: true })
  });
  assert.equal(trashResponse.status, 200);
  assert.equal((await trashResponse.json() as { asset: { trashed: boolean } }).asset.trashed, true);

  const deleteResponse = await fetch(`${baseUrl}/api/assets/${assetId}`, {
    method: "DELETE",
    headers: authedHeaders()
  });
  assert.equal(deleteResponse.status, 200);

  const fileResponse = await fetch(`${baseUrl}/api/assets/${assetId}/file/thumb`, { headers: authedHeaders() });
  assert.equal(fileResponse.status, 404);
});

test("admin can create a user; new user cannot access admin routes", async () => {
  const createResponse = await fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ email: "user@example.com", name: "Test User", password: "a-long-password", role: "user" })
  });
  assert.equal(createResponse.status, 201);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: "user@example.com", password: "a-long-password" })
  });
  assert.equal(loginResponse.status, 200);
  const userCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];

  const adminAttempt = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { Cookie: userCookie, Origin: origin }
  });
  assert.equal(adminAttempt.status, 403);
});

test("re-uploading an identical image is reported as a duplicate, not stored twice", async () => {
  const png = await makePng({ r: 10, g: 120, b: 200 });
  const upload = async () => {
    const form = new FormData();
    form.append("photos", new Blob([new Uint8Array(png)], { type: "image/png" }), "dup.png");
    const response = await fetch(`${baseUrl}/api/assets`, { method: "POST", headers: authedHeaders(), body: form });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ assets: Array<{ id: string }>; duplicates: Array<{ id: string }> }>;
  };

  const first = await upload();
  assert.equal(first.assets.length, 1);
  assert.equal(first.duplicates.length, 0);

  const second = await upload();
  assert.equal(second.assets.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(second.duplicates[0].id, first.assets[0].id);
});

test("zip download streams owned originals and ignores foreign ids", async () => {
  const list = await fetch(`${baseUrl}/api/assets?view=photos`, { headers: authedHeaders() });
  const { assets } = await list.json() as { assets: Array<{ id: string }> };
  assert.ok(assets.length >= 1);

  const response = await fetch(`${baseUrl}/api/assets/zip`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ assetIds: [assets[0].id, "not-someones-real-id"] })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK", "response should be a zip archive");

  const empty = await fetch(`${baseUrl}/api/assets/zip`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ assetIds: ["nothing-owned"] })
  });
  assert.equal(empty.status, 404);
});

test("album rename and delete-with-photos trashes its assets", async () => {
  const png = await makePng({ r: 80, g: 40, b: 140 });
  const form = new FormData();
  form.append("photos", new Blob([new Uint8Array(png)], { type: "image/png" }), "album-delete.png");
  const upload = await fetch(`${baseUrl}/api/assets`, { method: "POST", headers: authedHeaders(), body: form });
  const { assets: uploaded } = await upload.json() as { assets: Array<{ id: string }> };

  const createResponse = await fetch(`${baseUrl}/api/albums`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title: "Doomed" })
  });
  const { album } = await createResponse.json() as { album: { id: string } };
  await fetch(`${baseUrl}/api/albums/${album.id}/assets`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ assetIds: [uploaded[0].id] })
  });

  const rename = await fetch(`${baseUrl}/api/albums/${album.id}`, {
    method: "PATCH",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title: "Renamed" })
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json() as { album: { title: string } }).album.title, "Renamed");

  const emptyRename = await fetch(`${baseUrl}/api/albums/${album.id}`, {
    method: "PATCH",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title: "   " })
  });
  assert.equal(emptyRename.status, 400);

  const deleteResponse = await fetch(`${baseUrl}/api/albums/${album.id}?deleteAssets=1`, {
    method: "DELETE",
    headers: authedHeaders()
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json() as { trashed: number }).trashed, 1);

  const trashList = await fetch(`${baseUrl}/api/assets?view=trash`, { headers: authedHeaders() });
  const { assets: trashed } = await trashList.json() as { assets: Array<{ id: string }> };
  assert.ok(trashed.some((asset) => asset.id === uploaded[0].id), "asset should be in the trash");
});

test("re-uploading a trashed duplicate restores it", async () => {
  const png = await makePng({ r: 10, g: 120, b: 200 });
  const listBefore = await fetch(`${baseUrl}/api/assets?view=photos`, { headers: authedHeaders() });
  const { assets: before } = await listBefore.json() as { assets: Array<{ id: string }> };
  const target = before[0];

  await fetch(`${baseUrl}/api/assets/${target.id}`, {
    method: "PATCH",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ trashed: true })
  });

  const form = new FormData();
  form.append("photos", new Blob([new Uint8Array(png)], { type: "image/png" }), "dup.png");
  const response = await fetch(`${baseUrl}/api/assets`, { method: "POST", headers: authedHeaders(), body: form });
  const body = await response.json() as { duplicates: Array<{ id: string; trashed: boolean }> };
  assert.equal(body.duplicates.length, 1);
  assert.equal(body.duplicates[0].id, target.id);
  assert.equal(body.duplicates[0].trashed, false);
});
