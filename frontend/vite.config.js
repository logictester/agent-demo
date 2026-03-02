import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:4000",
      "/agent": "http://localhost:4000",
      "/delegation": "http://localhost:4000",
      "/automation": "http://localhost:4000",
    },
  },
});
