import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { env } from "./lib/env.js";
import { v1 } from "./routes/v1.js";
import { db } from "./db/client.js";
import { globalLimit } from "./middleware/rateLimit.js";
import { requestId } from "./middleware/auth.js";

const app = new Hono();

// ─── Global Middleware ────────────────────────────────────────────────────────

// Request correlation ID — logged and returned in every response
app.use("*", requestId);

// Only log requests in non-production or when explicitly enabled
if (env.NODE_ENV !== "production" || process.env.ENABLE_REQUEST_LOG === "1") {
  app.use("*", logger());
}

app.use(
  "*",
  secureHeaders({
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "strict-origin-when-cross-origin",
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
    },
  })
);

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS.split(","),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// ─── Global rate limit ────────────────────────────────────────────────────────

app.use("/api/*", globalLimit);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", async (c) => {
  let dbOk = false;
  try { await db.$queryRaw`SELECT 1`; dbOk = true; } catch {}
  const status = dbOk ? "operational" : "degraded";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Yesp Auth API</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8f9fb;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 48px;max-width:480px;width:100%;text-align:center}
    .logo{width:44px;height:44px;background:linear-gradient(135deg,#1d4ed8,#4f46e5);border-radius:10px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px}
    .logo svg{width:24px;height:24px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    h1{font-size:1.25rem;font-weight:700;color:#0f172a;margin-bottom:4px}
    .sub{font-size:.875rem;color:#64748b;margin-bottom:32px}
    .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;font-size:.75rem;font-weight:600;margin-bottom:32px}
    .operational{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
    .degraded{background:#fff7ed;color:#ea580c;border:1px solid #fed7aa}
    .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
    table{width:100%;border-collapse:collapse;text-align:left;font-size:.8125rem}
    td{padding:10px 0;border-bottom:1px solid #f1f5f9;color:#334155}
    td:first-child{color:#94a3b8;font-weight:500;width:40%}
    tr:last-child td{border:none}
    .footer{margin-top:28px;font-size:.75rem;color:#94a3b8}
    .footer a{color:#3b82f6;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    </div>
    <h1>Yesp Auth API</h1>
    <p class="sub">Identity &amp; Access Management · ${env.APP_URL.replace(/^https?:\/\//, "")}</p>
    <div class="badge ${status}">
      <span class="dot"></span>
      ${status === "operational" ? "All systems operational" : "Database degraded"}
    </div>
    <table>
      <tr><td>Service</td><td>yesp-auth-api</td></tr>
      <tr><td>Version</td><td>1.0.0</td></tr>
      <tr><td>Database</td><td>${dbOk ? "Connected" : "Unavailable"}</td></tr>
      <tr><td>Timestamp</td><td>${new Date().toISOString()}</td></tr>
      <tr><td>Docs</td><td>/api/v1</td></tr>
    </table>
    <p class="footer">Part of <a href="https://yespstudio.com" target="_blank">Yesp Corporation</a> · Built by Srinithin Somasundaram</p>
  </div>
</body>
</html>`;
  return c.html(html, dbOk ? 200 : 503);
});

app.get("/health", async (c) => {
  try {
    await db.$queryRaw`SELECT 1`;
    return c.json({ status: "ok", service: "yesp-auth", timestamp: new Date().toISOString() });
  } catch {
    return c.json({ status: "degraded" }, 503);
  }
});

app.route("/api/v1", v1);

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error("[ERROR]", err);
  return c.json({ error: "internal_server_error" }, 500);
});

// ─── Start ────────────────────────────────────────────────────────────────────

// $PORT is injected by hosting platforms (Nimbuz, Railway, Render, etc.)
const apiPort = Number(process.env.PORT) || env.API_PORT;
serve({ fetch: app.fetch, port: apiPort }, (info) => {
  console.log(`Yesp Auth running on http://localhost:${info.port}`);
});
