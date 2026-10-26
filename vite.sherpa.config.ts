import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  // The renderer may be served from a separate HTTPS origin or a path under
  // that origin. Keep its generated module and stylesheet URLs relative to
  // sherpa.html instead of pinning them to the host root.
  base: "./",
  publicDir: false,
  build: {
    outDir: "dist-sherpa",
    emptyOutDir: true,
    rollupOptions: {
      input: "sherpa.html",
    },
  },
});
