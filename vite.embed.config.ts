/**
 * Vite config for building the embed widget as a self-contained IIFE bundle.
 *
 * Output: dist/public/embed-popup.js
 *
 * IMPORTANT: This config uses emptyOutDir: false so it appends to the
 * main build output. The build script MUST run `vite build` (main) first,
 * then `vite build --config vite.embed.config.ts` (this).
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: "client",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, "client/src/embed/standalone-bundle-root.tsx"),
      name: "BionicEmbed",
      fileName: () => "embed-popup.js",
      formats: ["iife"],
    },
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: false, // CRITICAL: do not wipe the main Vite build
    cssCodeSplit: false, // inline CSS into JS for Shadow DOM injection
    sourcemap: true,
    rollupOptions: {
      // React is bundled INTO the widget — host page may not have React
      output: {
        // Ensure single file output
        inlineDynamicImports: true,
      },
    },
  },
});
