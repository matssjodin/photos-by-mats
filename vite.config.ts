import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // changeOrigin must stay false: the string shorthand implies
      // changeOrigin: true, which rewrites Host to localhost:4000 while the
      // browser sends Origin: http://localhost:5173 — the server's CSRF guard
      // compares the two and rejects every dev login with a 403.
      "/api": { target: "http://localhost:4000", changeOrigin: false }
    }
  },
  build: {
    outDir: "dist-client"
  }
});
