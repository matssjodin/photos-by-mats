// Visual smoke check: boots the built app against a throwaway DATA_DIR, seeds
// a few photos and an album, then captures mobile + desktop screenshots with
// the locally installed Edge browser. Usage: node scripts/visual-check.mjs
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import puppeteer from "puppeteer-core";

const edgePaths = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser"
];

const port = 4321;
const base = `http://127.0.0.1:${port}`;
const outDir = path.resolve("verify-shots");
const adminEmail = "admin@example.com";
const adminPassword = "change-me-before-deploy";

async function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error("No Edge/Chrome executable found.");
}

async function waitForServer(deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("Server did not start.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function seed() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  if (!login.ok) throw new Error(`Login failed: ${login.status}`);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const token = cookie.split("=")[1];

  const images = [
    { name: "meadow.png", width: 1600, height: 1000, background: { r: 96, g: 148, b: 110 } },
    { name: "harbour.png", width: 1000, height: 1500, background: { r: 70, g: 110, b: 160 } },
    { name: "dunes.png", width: 1200, height: 1200, background: { r: 210, g: 170, b: 110 } },
    { name: "evening.png", width: 1800, height: 900, background: { r: 150, g: 90, b: 110 } },
    { name: "forest.png", width: 900, height: 1400, background: { r: 60, g: 100, b: 70 } },
    { name: "frost.png", width: 1400, height: 1000, background: { r: 170, g: 190, b: 205 } }
  ];
  const form = new FormData();
  for (const image of images) {
    const buffer = await sharp({
      create: { width: image.width, height: image.height, channels: 3, background: image.background }
    }).png().toBuffer();
    form.append("photos", new Blob([new Uint8Array(buffer)], { type: "image/png" }), image.name);
  }
  const upload = await fetch(`${base}/api/assets`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: base },
    body: form
  });
  if (!upload.ok) throw new Error(`Upload failed: ${upload.status}`);
  const { assets } = await upload.json();

  const albumResponse = await fetch(`${base}/api/albums`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Summer 2026" })
  });
  const { album } = await albumResponse.json();
  await fetch(`${base}/api/albums/${album.id}/assets`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ assetIds: assets.map((asset) => asset.id) })
  });

  return token;
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sjodin-visual-"));
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const server = spawn(process.execPath, ["dist-server/index.js"], {
    env: { ...process.env, NODE_ENV: "development", DATA_DIR: dataDir, PORT: String(port) },
    stdio: "inherit"
  });

  let browser;
  try {
    await waitForServer();
    const token = await seed();

    browser = await puppeteer.launch({
      executablePath: await firstExisting(edgePaths),
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"]
    });
    const page = await browser.newPage();
    const mobile = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    await page.setViewport(mobile);

    // 1. Login screen
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.screenshot({ path: path.join(outDir, "01-login-mobile.png") });

    // Authenticate via cookie and reload into the app
    await browser.setCookie({ name: "sjodin_session", value: token, domain: "127.0.0.1", path: "/" });
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.waitForSelector(".photo-tile");
    await page.screenshot({ path: path.join(outDir, "02-photos-mobile.png") });

    // 2. Viewer
    await page.tap(".photo-tile");
    await page.waitForSelector(".viewer-image");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.screenshot({ path: path.join(outDir, "03-viewer-mobile.png") });

    // 3. Viewer info sheet
    await page.tap('button[title="Show info"]');
    await page.waitForSelector(".info-panel");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({ path: path.join(outDir, "04-viewer-info-mobile.png") });
    await page.tap('button[title="Close"]');

    // 4. Select mode
    await page.waitForSelector(".photo-tile");
    const selectButton = await page.waitForSelector("xpath/.//button[normalize-space()='Select']");
    await selectButton.tap();
    await page.tap(".photo-tile");
    await page.waitForSelector(".select-bar");
    await page.screenshot({ path: path.join(outDir, "05-select-mobile.png") });
    const doneButton = await page.waitForSelector("xpath/.//button[normalize-space()='Done']");
    await doneButton.tap();

    // 5. Albums
    const albumsTab = await page.waitForSelector("xpath/.//nav//button[.//span[text()='Albums']]");
    await albumsTab.tap();
    await page.waitForSelector(".album-tile");
    await page.screenshot({ path: path.join(outDir, "06-albums-mobile.png") });

    // 6. Inside album
    await page.tap(".album-open");
    await page.waitForSelector(".photo-tile");
    await page.screenshot({ path: path.join(outDir, "07-album-mobile.png") });

    // 7. Desktop layout
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.waitForSelector(".photo-tile");
    await page.screenshot({ path: path.join(outDir, "08-photos-desktop.png") });
    await page.click(".photo-tile");
    await page.waitForSelector(".viewer-image");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.screenshot({ path: path.join(outDir, "09-viewer-desktop.png") });

    console.log(`Screenshots written to ${outDir}`);
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
