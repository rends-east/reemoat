import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * In dev the control plane is a different process on a different port, so `/v1`
 * is proxied rather than fetched cross-origin. That keeps dev and production the
 * same shape — the API key only ever goes to this page's own origin — instead of
 * making dev the one place a CORS rule has to exist for the control plane.
 *
 * Daemons and the relay are *not* proxied. Those really are cross-origin in
 * production, and hiding that in dev would mean discovering it on a phone.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    proxy: {
      "/v1": { target: "http://127.0.0.1:7888", changeOrigin: false },
      // The installer the empty-fleet screens print, for the same reason and
      // with the same `changeOrigin: false`: the control plane substitutes the
      // `Host` it was asked on into the script it serves, so leaving the header
      // alone is what makes the command this page draws and the command that
      // URL answers with name the same address in dev.
      "/install.sh": { target: "http://127.0.0.1:7888", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    // A phone on LTE. Worth the build time.
    target: "es2022",
    // `"hidden"` rather than `true`: the maps are still written, so they can be
    // uploaded to an error tracker, but nothing in the bundle references them
    // and `deploy/docker/Dockerfile` drops them before the runtime stage.
    // Measured on this bundle: 4.1 MB of `.map` across 15 files, the main one
    // 4,017,366 bytes — shipped into the image behind `/`, a route that needs
    // no credential, where the control plane's gzip middleware re-compressed
    // that one file from scratch at 98.7 ms of CPU per request.
    sourcemap: "hidden",
  },
});
