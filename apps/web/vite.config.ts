import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.AGENT_WORKBENCH_PORT ?? "3030";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/ws": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
});
