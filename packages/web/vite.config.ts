import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production lives at games.greg.kitchen/summoners, served by the Cloudflare Worker from deploy/assets.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/summoners/" : "/",
  plugins: [react()],
  build: {
    outDir: "../../deploy/assets/summoners",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
}));
