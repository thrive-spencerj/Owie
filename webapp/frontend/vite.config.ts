import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8020",
      "/ws": { target: "ws://localhost:8020", ws: true },
    },
  },
});
