import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { spawn, spawnSync } from "node:child_process";
import localtunnel from "localtunnel";

/** @type {{ close?: () => void } | null} */
let tunnelHandle = null;

function cloudflaredAvailable() {
  const r = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });
  return r.status === 0 && !r.error;
}

/**
 * Cloudflare quick tunnel — no "enter your IP" page (unlike free localtunnel).
 * Install: brew install cloudflared
 */
function startCloudflareTunnel(port, logger) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://127.0.0.1:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let buf = "";
    let settled = false;

    const onChunk = (chunk) => {
      buf += chunk.toString();
      if (buf.length > 64_000) buf = buf.slice(-32_000);
      const m = buf.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (m && !settled) {
        settled = true;
        tunnelHandle = {
          close: () => {
            try {
              child.kill("SIGTERM");
            } catch {
              /* ignore */
            }
          },
        };
        resolve(m[0]);
      }
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });

    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        reject(new Error("cloudflared tunnel timed out"));
      }
    }, 45_000);

    const done = () => clearTimeout(t);
    child.once("exit", done);
  }).then((url) => {
    logger.info(
      `\n  ➜  Public tunnel: ${url}\n` +
        `  (open on phone on any network; no same Wi‑Fi needed)\n`,
    );
  });
}

async function startLocaltunnel(port, logger) {
  const lt = await localtunnel({ port });
  tunnelHandle = {
    close: () => {
      try {
        lt.close();
      } catch {
        /* ignore */
      }
    },
  };
  lt.on("error", (err) => {
    logger.warn(`Tunnel error: ${err.message}`);
  });
  logger.info(
    `\n  ➜  Public tunnel: ${lt.url}\n` +
      `  (open on phone on any network; no same Wi‑Fi needed)\n` +
      `\n  If a page asks for an IP: use your phone’s PUBLIC address (Safari → https://api.ipify.org ),\n` +
      `  not 192.168.x.x. Or install cloudflared (brew install cloudflared) to skip that step.\n`,
  );
}

/** @param {import("vite").PreviewServer | import("vite").ViteDevServer} server */
function attachPublicTunnel(server) {
  const disable = process.env.TUNNEL === "0" || process.env.TUNNEL === "false";
  if (disable) return;

  server.httpServer?.once("listening", async () => {
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") return;
    const port = address.port;
    const logger = server.config.logger;
    const mode = process.env.TUNNEL ?? "auto";

    try {
      if (mode === "localtunnel") {
        await startLocaltunnel(port, logger);
      } else if (mode === "cloudflare") {
        if (!cloudflaredAvailable()) {
          logger.warn(
            `TUNNEL=cloudflare but cloudflared is not installed. Install: brew install cloudflared`,
          );
          await startLocaltunnel(port, logger);
        } else {
          try {
            await startCloudflareTunnel(port, logger);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn(`Cloudflare tunnel failed (${msg}), trying localtunnel…`);
            await startLocaltunnel(port, logger);
          }
        }
      } else {
        if (cloudflaredAvailable()) {
          try {
            await startCloudflareTunnel(port, logger);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn(`Cloudflare tunnel failed (${msg}), trying localtunnel…`);
            await startLocaltunnel(port, logger);
          }
        } else {
          logger.info(
            `  (Install cloudflared for a smoother tunnel: brew install cloudflared)\n`,
          );
          await startLocaltunnel(port, logger);
        }
      }

      server.httpServer?.once("close", () => {
        tunnelHandle?.close?.();
        tunnelHandle = null;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`Could not start public tunnel (${msg}). Set TUNNEL=0 to skip.`);
    }
  });
}

function publicTunnelPlugin() {
  return {
    name: "public-tunnel",
    configureServer(server) {
      attachPublicTunnel(server);
    },
    configurePreviewServer(server) {
      attachPublicTunnel(server);
    },
  };
}

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Tour Guide",
        short_name: "Tour Guide",
        description:
          "Nearby landmarks and Wikipedia articles based on your location.",
        theme_color: "#0f1419",
        background_color: "#0f1419",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
      },
      devOptions: {
        enabled: true,
      },
    }),
    publicTunnelPlugin(),
  ],
  server: {
    // Match cloudflared origin (http://127.0.0.1:port). Binding only to IPv6 ::1 breaks that and yields 502 from trycloudflare.com.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: [".loca.lt", ".trycloudflare.com"],
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: [".loca.lt", ".trycloudflare.com"],
  },
});
