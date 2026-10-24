import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  root: ".",
  // The renderer may be served from a separate HTTPS origin or a path under
  // that origin. Keep its generated module and stylesheet URLs relative to
  // sherpa.html instead of pinning them to the host root.
  base: "./",
  publicDir: false,
  resolve: {
    // The root avatar-core entry eagerly constructs its AJV 2020 schema
    // validator. SHERPA's embed only needs the renderer, so keep the same
    // renderer API while using the package's schema-free geometry modules.
    alias: [
      {
        find: /^@bible-strong\/avatar-core$/,
        replacement: fileURLToPath(
          new URL("./src/lib/avatar-core-runtime.ts", import.meta.url),
        ),
      },
    ],
  },
  build: {
    outDir: "dist-sherpa",
    emptyOutDir: true,
    rollupOptions: {
      input: "sherpa.html",
    },
  },
});
