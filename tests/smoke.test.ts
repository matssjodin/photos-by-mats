import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";

const ffmpegBin = ffmpegStatic as unknown as string;

const port = 40000 + (process.pid % 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const origin = baseUrl;
const adminEmail = "admin@example.com";
const adminPassword = "change-me-before-deploy";

let server: ChildProcess;
let dataDir: string;
let serverLog = "";
let sessionCookie = "";
let stopping = false;

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
  // A server that dies mid-run only shows up as ECONNREFUSED in later tests;
  // print its log so the real cause is visible.
  server.on("exit", (code) => {
    if (!stopping) console.error(`Server exited unexpectedly (code ${code}). Log:\n${serverLog}`);
  });

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
  stopping = true;
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

/** Synthesize a tiny H.264 MP4 with the bundled ffmpeg for the video test. */
async function makeMp4(): Promise<Buffer> {
  const out = path.join(dataDir, `seed-${crypto.randomUUID()}.mp4`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBin, [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=duration=2:size=320x240:rate=15",
      "-pix_fmt", "yuv420p",
      out
    ], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg seed failed with code ${code}`))));
  });
  const buf = await fs.readFile(out);
  await fs.rm(out, { force: true }).catch(() => undefined);
  return buf;
}

test("health endpoint responds with security headers", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.ok(response.headers.get("content-security-policy")?.includes("default-src 'self'"));
});

test("branding config and PWA manifest reflect APP_NAME defaults", async () => {
  const config = await fetch(`${baseUrl}/api/config`);
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), {
    appName: "Sjodin Photos",
    appShortName: "Photos",
    attributionText: "Photoalbum by Mats Sjödin",
    attributionUrl: "https://matssjodin.com",
    maxUploadFileSizeMb: 120,
    maxUploadVideoSizeMb: 2048
  });

  const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  const body = await manifest.json() as { name: string; short_name: string; share_target: unknown };
  assert.equal(body.name, "Sjodin Photos");
  assert.equal(body.short_name, "Photos");
  assert.ok(body.share_target, "manifest must keep the share_target");
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

test("the EXIF capture date becomes the photo's takenAt", async () => {
  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .withExif({ IFD2: { DateTimeOriginal: "2019:05:06 07:08:09" } })
    .jpeg()
    .toBuffer();
  const form = new FormData();
  form.append("photos", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "exif-date.jpg");
  const response = await fetch(`${baseUrl}/api/assets`, { method: "POST", headers: authedHeaders(), body: form });
  assert.equal(response.status, 201);
  const body = await response.json() as { assets: Array<{ takenAt: string }> };
  assert.equal(body.assets.length, 1);
  // EXIF dates carry no timezone, so only the calendar year/month is asserted.
  assert.ok(body.assets[0].takenAt.startsWith("2019-05-0"), `takenAt was ${body.assets[0].takenAt}`);
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

test("asset descriptions save, validate, survive other patches, and show on shared albums", async () => {
  const jsonHeaders = authedHeaders({ "Content-Type": "application/json" });
  const patch = async (body: unknown) => fetch(`${baseUrl}/api/assets/${assetId}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });

  const saved = await patch({ description: "  Grandma's garden, summer 2024  " });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json() as { asset: { description: string } }).asset.description, "Grandma's garden, summer 2024", "description is trimmed");

  assert.equal((await patch({ description: "x".repeat(2001) })).status, 400, "over-long descriptions are rejected");
  assert.equal((await patch({ description: 42 })).status, 400, "non-text descriptions are rejected");

  // Patching other fields leaves the description alone.
  const favorite = await patch({ favorite: true });
  assert.equal((await favorite.json() as { asset: { description: string } }).asset.description, "Grandma's garden, summer 2024");

  // Visible to anyone with a share link.
  const album = (await (await fetch(`${baseUrl}/api/albums`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Captioned" })
  })).json() as { album: { id: string } }).album;
  await fetch(`${baseUrl}/api/albums/${album.id}/assets`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ assetIds: [assetId] }) });
  const share = await (await fetch(`${baseUrl}/api/albums/${album.id}/share`, { method: "POST", headers: authedHeaders() })).json() as { album: { shareToken: string } };
  const shared = await (await fetch(`${baseUrl}/api/share/${share.album.shareToken}`)).json() as { assets: Array<{ description: string }> };
  assert.equal(shared.assets[0].description, "Grandma's garden, summer 2024");

  // Empty text clears it.
  const cleared = await patch({ description: "   " });
  assert.equal((await cleared.json() as { asset: { description: string } }).asset.description, "");
});

test("album order is manual: members append, PUT /order rearranges, listings honour it", async () => {
  const jsonHeaders = authedHeaders({ "Content-Type": "application/json" });
  const ids = [assetId];
  for (const background of [{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }]) {
    const form = new FormData();
    form.append("photos", new Blob([new Uint8Array(await makePng(background))], { type: "image/png" }), `order-${ids.length}.png`);
    const response = await fetch(`${baseUrl}/api/assets`, { method: "POST", headers: authedHeaders(), body: form });
    assert.equal(response.status, 201);
    ids.push((await response.json() as { assets: Array<{ id: string }> }).assets[0].id);
  }
  const [a, b, c] = ids;

  const album = (await (await fetch(`${baseUrl}/api/albums`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Ordered" })
  })).json() as { album: { id: string } }).album;
  // Add in a deliberately non-chronological order: members append in the order given.
  await fetch(`${baseUrl}/api/albums/${album.id}/assets`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ assetIds: [c, a] }) });
  await fetch(`${baseUrl}/api/albums/${album.id}/assets`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ assetIds: [b] }) });
  const listIds = async () => (await (await fetch(`${baseUrl}/api/albums/${album.id}/assets`, { headers: authedHeaders() })).json() as { assets: Array<{ id: string }> }).assets.map((asset) => asset.id);
  assert.deepEqual(await listIds(), [c, a, b]);

  const reorder = await fetch(`${baseUrl}/api/albums/${album.id}/order`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ assetIds: [b, c, a] }) });
  assert.equal(reorder.status, 200);
  assert.deepEqual((await reorder.json() as { assetIds: string[] }).assetIds, [b, c, a]);
  assert.deepEqual(await listIds(), [b, c, a]);

  // Shared listings use the same order.
  const share = await (await fetch(`${baseUrl}/api/albums/${album.id}/share`, { method: "POST", headers: authedHeaders() })).json() as { album: { shareToken: string } };
  const shared = await (await fetch(`${baseUrl}/api/share/${share.album.shareToken}`)).json() as { assets: Array<{ id: string }> };
  assert.deepEqual(shared.assets.map((asset) => asset.id), [b, c, a]);

  // Partial lists go first; unknown ids are ignored; the rest keep their relative order.
  const partial = await fetch(`${baseUrl}/api/albums/${album.id}/order`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ assetIds: ["nope", a] }) });
  assert.equal(partial.status, 200);
  assert.deepEqual(await listIds(), [a, b, c]);

  assert.equal((await fetch(`${baseUrl}/api/albums/${album.id}/order`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ assetIds: "a,b" }) })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/albums/does-not-exist/order`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ assetIds: [a] }) })).status, 404);
});

test("inSharedAlbum tracks membership and revoking a share keeps the photos", async () => {
  // Upload a dedicated asset and confirm it is not flagged as shared yet.
  const png = await makePng({ r: 33, g: 99, b: 150 });
  const form = new FormData();
  form.append("photos", new Blob([new Uint8Array(png)], { type: "image/png" }), "shared-flag.png");
  const upload = await fetch(`${baseUrl}/api/assets`, { method: "POST", headers: authedHeaders(), body: form });
  const { assets: uploaded } = await upload.json() as { assets: Array<{ id: string; inSharedAlbum: boolean }> };
  const id = uploaded[0].id;
  assert.equal(uploaded[0].inSharedAlbum, false);

  // Put it in an album and share that album.
  const album = (await (await fetch(`${baseUrl}/api/albums`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title: "Shared flag" })
  })).json() as { album: { id: string } }).album;
  await fetch(`${baseUrl}/api/albums/${album.id}/assets`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ assetIds: [id] })
  });
  await fetch(`${baseUrl}/api/albums/${album.id}/share`, { method: "POST", headers: authedHeaders() });

  const listShared = await fetch(`${baseUrl}/api/assets?view=photos`, { headers: authedHeaders() });
  const sharedAsset = (await listShared.json() as { assets: Array<{ id: string; inSharedAlbum: boolean }> })
    .assets.find((a) => a.id === id);
  assert.equal(sharedAsset?.inSharedAlbum, true, "asset in a shared album must be flagged");

  // Revoking the share must NOT delete the asset, and clears the flag.
  const unshare = await fetch(`${baseUrl}/api/albums/${album.id}/share`, { method: "DELETE", headers: authedHeaders() });
  assert.equal(unshare.status, 200);

  const stillThere = await fetch(`${baseUrl}/api/assets/${id}/file/thumb`, { headers: authedHeaders() });
  assert.equal(stillThere.status, 200, "revoking a share must keep the photo");

  const listAfter = await fetch(`${baseUrl}/api/assets?view=photos`, { headers: authedHeaders() });
  const afterAsset = (await listAfter.json() as { assets: Array<{ id: string; inSharedAlbum: boolean }> })
    .assets.find((a) => a.id === id);
  assert.equal(afterAsset?.inSharedAlbum, false, "flag clears once the album is no longer shared");
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

test("empty trash permanently deletes all trashed photos", async () => {
  const png = await makePng({ r: 5, g: 200, b: 90 });
  const form = new FormData();
  form.append("photos", new Blob([new Uint8Array(png)], { type: "image/png" }), "empty-trash.png");
  const upload = await fetch(`${baseUrl}/api/assets`, { method: "POST", headers: authedHeaders(), body: form });
  const { assets: uploaded } = await upload.json() as { assets: Array<{ id: string }> };

  await fetch(`${baseUrl}/api/assets/${uploaded[0].id}`, {
    method: "PATCH",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ trashed: true })
  });

  const empty = await fetch(`${baseUrl}/api/trash/empty`, { method: "POST", headers: authedHeaders() });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json() as { deleted: number }).deleted >= 1, true);

  const trashList = await fetch(`${baseUrl}/api/assets?view=trash`, { headers: authedHeaders() });
  const { assets: remaining } = await trashList.json() as { assets: unknown[] };
  assert.equal(remaining.length, 0);

  const gone = await fetch(`${baseUrl}/api/assets/${uploaded[0].id}/file/thumb`, { headers: authedHeaders() });
  assert.equal(gone.status, 404);
});

test("video upload transcodes in the background and serves streamable renditions", async () => {
  const mp4 = await makeMp4();
  const form = new FormData();
  form.append("photos", new Blob([new Uint8Array(mp4)], { type: "video/mp4" }), "clip.mp4");
  const response = await fetch(`${baseUrl}/api/assets`, { method: "POST", headers: authedHeaders(), body: form });
  assert.equal(response.status, 201);
  const body = await response.json() as {
    assets: Array<{ id: string; mediaType: string; status: string; urls: { video: string | null } }>;
  };
  assert.equal(body.assets.length, 1);
  const video = body.assets[0];
  assert.equal(video.mediaType, "video");
  assert.equal(video.status, "processing");
  assert.equal(video.urls.video, null, "renditions are not exposed until transcoding finishes");

  // Poll until the background transcode flips the asset to ready.
  type Listed = {
    id: string;
    status: string;
    storyboard: { interval: number; cols: number; rows: number; count: number; tileWidth: number; tileHeight: number } | null;
    urls: { video: string | null; videoSd: string | null; original: string | null; hls: string | null; storyboard: string | null };
  };
  const deadline = Date.now() + 60000;
  let ready: Listed | undefined;
  for (;;) {
    const list = await fetch(`${baseUrl}/api/assets?view=photos`, { headers: authedHeaders() });
    const { assets } = await list.json() as { assets: Listed[] };
    const found = assets.find((a) => a.id === video.id);
    assert.notEqual(found?.status, "failed", "transcode must not fail");
    if (found?.status === "ready") { ready = found; break; }
    if (Date.now() > deadline) throw new Error("video did not finish transcoding within 60s");
    await new Promise((r) => setTimeout(r, 1000));
  }

  assert.ok(ready.urls.video);
  const full = await fetch(`${baseUrl}${ready.urls.video}`, { headers: authedHeaders() });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");

  // A Range request must return 206 partial content so the player can seek.
  const ranged = await fetch(`${baseUrl}${ready.urls.video}`, { headers: authedHeaders({ Range: "bytes=0-99" }) });
  assert.equal(ranged.status, 206);
  assert.ok(ranged.headers.get("content-range")?.startsWith("bytes 0-99/"));

  assert.ok(ready.urls.videoSd);
  const sd = await fetch(`${baseUrl}${ready.urls.videoSd}`, { headers: authedHeaders() });
  assert.equal(sd.status, 200);

  // Adaptive streaming: the master playlist advertises both renditions and the
  // media playlists reference byte ranges of the rendition MP4s via the API.
  assert.ok(ready.urls.hls, "ready videos expose an HLS master playlist");
  const master = await fetch(`${baseUrl}${ready.urls.hls}`, { headers: authedHeaders() });
  assert.equal(master.status, 200);
  assert.ok((master.headers.get("content-type") ?? "").includes("mpegurl"));
  const masterText = await master.text();
  assert.ok(masterText.includes("#EXT-X-STREAM-INF"));
  assert.ok(masterText.includes("v1080.m3u8"));
  assert.ok(masterText.includes("v480.m3u8"));

  const variantUrl = ready.urls.hls!.replace(/master\.m3u8$/, "v1080.m3u8");
  const variant = await fetch(`${baseUrl}${variantUrl}`, { headers: authedHeaders() });
  assert.equal(variant.status, 200);
  const variantText = await variant.text();
  assert.ok(variantText.includes("#EXT-X-BYTERANGE"));
  assert.ok(variantText.includes("../file/video"));

  // The playlist's relative media URI must resolve to a Range-capable endpoint.
  const byteRange = variantText.match(/#EXT-X-BYTERANGE:(\d+)@(\d+)/);
  assert.ok(byteRange, "media playlist declares byte-range segments");
  const mediaUrl = new URL("../file/video", `${baseUrl}${variantUrl}`);
  const rangeStart = Number(byteRange![2]);
  const rangeEnd = rangeStart + Number(byteRange![1]) - 1;
  const segment = await fetch(mediaUrl, { headers: authedHeaders({ Range: `bytes=${rangeStart}-${rangeEnd}` }) });
  assert.equal(segment.status, 206);

  // HLS playlists require an authenticated session.
  const anonymous = await fetch(`${baseUrl}${ready.urls.hls}`);
  assert.equal(anonymous.status, 401);

  // Scrub-preview storyboard sprite plus its layout metadata.
  assert.ok(ready.storyboard, "ready videos include storyboard metadata");
  assert.ok(ready.storyboard!.count >= 1);
  assert.ok(ready.urls.storyboard);
  const sprite = await fetch(`${baseUrl}${ready.urls.storyboard}`, { headers: authedHeaders() });
  assert.equal(sprite.status, 200);
  assert.equal(sprite.headers.get("content-type"), "image/jpeg");

  // Shared albums stream over the share-scoped HLS routes (never the original).
  const albumResponse = await fetch(`${baseUrl}/api/albums`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title: "Video share" })
  });
  const { album } = await albumResponse.json() as { album: { id: string } };
  await fetch(`${baseUrl}/api/albums/${album.id}/assets`, {
    method: "POST",
    headers: authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ assetIds: [video.id] })
  });
  const shareResponse = await fetch(`${baseUrl}/api/albums/${album.id}/share`, { method: "POST", headers: authedHeaders() });
  const { album: sharedAlbum } = await shareResponse.json() as { album: { shareToken: string } };
  const publicList = await fetch(`${baseUrl}/api/share/${sharedAlbum.shareToken}`);
  const publicBody = await publicList.json() as { assets: Listed[] };
  const publicVideo = publicBody.assets.find((a) => a.id === video.id);
  assert.ok(publicVideo?.urls.hls, "shared videos expose the share-scoped HLS playlist");
  assert.equal(publicVideo!.urls.original, null);
  const publicMaster = await fetch(`${baseUrl}${publicVideo!.urls.hls}`);
  assert.equal(publicMaster.status, 200);
  const publicVariantUrl = publicVideo!.urls.hls!.replace(/master\.m3u8$/, "v480.m3u8");
  const publicVariant = await fetch(`${baseUrl}${publicVariantUrl}`);
  assert.equal(publicVariant.status, 200);
  const publicVariantText = await publicVariant.text();
  assert.ok(publicVariantText.includes("../file/video_sd"));
  const publicMedia = await fetch(new URL("../file/video_sd", `${baseUrl}${publicVariantUrl}`));
  assert.equal(publicMedia.status, 200, "share playlist media URIs must resolve without auth");
  const publicSprite = await fetch(`${baseUrl}${publicVideo!.urls.storyboard}`);
  assert.equal(publicSprite.status, 200);

  // Owner "original" download serves the 1080p MP4 with a .mp4 filename.
  assert.ok(ready.urls.original);
  const original = await fetch(`${baseUrl}${ready.urls.original}`, { headers: authedHeaders() });
  assert.equal(original.status, 200);
  assert.ok(original.headers.get("content-disposition")?.includes(".mp4"));

  // Deleting wipes the whole asset directory.
  const del = await fetch(`${baseUrl}/api/assets/${video.id}`, { method: "DELETE", headers: authedHeaders() });
  assert.equal(del.status, 200);
  const gone = await fetch(`${baseUrl}${ready.urls.video}`, { headers: authedHeaders() });
  assert.equal(gone.status, 404);
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
