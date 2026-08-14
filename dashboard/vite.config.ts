import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Load the root .env so development and production ports stay explicit.
  const env = loadEnv(mode, "..", "");
  const dashboardPort = Number(env.DASHBOARD_PORT) || 1931;
  const apiPort = mode === "development"
    ? Number(env.DEV_API_PORT) || 1932
    : Number(env.PORT) || 1930;

  return {
    envDir: "..",
    plugins: [react()],
    build: {
      outDir: "dist",
    },
    server: {
      port: dashboardPort,
      strictPort: true,
      proxy: {
        "/api": `http://localhost:${apiPort}`,
        "/v1": `http://localhost:${apiPort}`,
        "/health": `http://localhost:${apiPort}`,
        "/ws": {
          target: `ws://localhost:${apiPort}`,
          ws: true,
        },
      },
    },
  };
});
