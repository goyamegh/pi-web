import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 9876);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: `PI_WEB_MOCK=1 PI_WEB_DEV=1 HOST=127.0.0.1 PORT=${port} PI_WEB_TOKEN= node --import tsx server.ts`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 20_000,
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 5"] } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
