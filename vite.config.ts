import { defineConfig } from "vite";

export default defineConfig({
  appType: "spa",
  server: {
    // Dev server is protected by PI_WEB_TOKEN and commonly accessed via
    // Tailscale MagicDNS names like http://studio:8787.
    allowedHosts: true,
  },
});
