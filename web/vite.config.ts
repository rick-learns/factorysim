import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works from any static host subpath.
  base: "./",
  // The bundled template lives in ../fixtures, shared with the Rust tests.
  server: { fs: { allow: [".."] } },
});
