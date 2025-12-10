import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy API to Node server in dev
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:4000"
    }
  }
});

