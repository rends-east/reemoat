import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// A separate build, not a second input, so dist-gate shares no chunks with dist and the image cannot carry the app.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist-gate",
    target: "es2022",
    // Written, then dropped by the Dockerfile before the runtime stage.
    sourcemap: "hidden",
    rollupOptions: { input: resolve(import.meta.dirname, "gate.html") },
  },
});
