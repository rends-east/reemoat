import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// Dev proxies only the control plane, as same-origin as in production; daemons and the relay stay cross-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    host: true,
    proxy: {
      "/v1": { target: "http://127.0.0.1:7888", changeOrigin: false },
      // Host left alone so the installer the control plane serves names the address this page shows.
      "/install.sh": { target: "http://127.0.0.1:7888", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: "hidden",
  },
});
