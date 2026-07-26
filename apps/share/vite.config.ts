import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: "web",
  resolve: { alias: { "@": path.resolve(__dirname, "web/src") } },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" } },
  },
});
