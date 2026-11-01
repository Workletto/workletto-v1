import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    // The API runs as its own process in development (see scripts/dev.mjs).
    proxy: { "/api": "http://localhost:3000", "/pay": "http://localhost:3000" },
  },
});
