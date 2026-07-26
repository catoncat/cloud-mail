import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./routes/api";
import { publicRoutes } from "./routes/public";
import { service } from "./routes/service";
import type { Env } from "./lib/types";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/v1/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-service-token"], allowMethods: ["GET", "POST", "OPTIONS"] }));
app.use("/admin/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-admin-key"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }));

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
});

app.route("/admin/api", api);
app.route("/api/v1", service);

/**
 * Retired service worker.
 * Older clients still fetch this path during update checks; serving a
 * self-unregistering body is the only reliable way to recover them.
 */
app.get("/sw.js", (c) =>
  c.body(
    `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  try{const k=await caches.keys();await Promise.all(k.map(x=>caches.delete(x)))}catch(_){}
  try{await self.registration.unregister()}catch(_){}
  try{(await self.clients.matchAll({type:'window'})).forEach(c=>c.navigate(c.url))}catch(_){}
})()));`,
    200,
    { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" },
  ),
);

app.get("/manifest.webmanifest", (c) =>
  c.json(
    {
      id: "/admin",
      name: "邮箱控制台",
      short_name: "控制台",
      description: "域名与邮箱验证码管理",
      start_url: "/admin",
      scope: "/",
      display: "standalone",
      background_color: "#fafafa",
      theme_color: "#18181b",
      lang: "zh-CN",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    200,
    { "content-type": "application/manifest+json; charset=utf-8" },
  ),
);

const ICON = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

app.get("/icons/:name", (c) => {
  const bytes = Uint8Array.from(atob(ICON), (ch) => ch.charCodeAt(0));
  return c.body(bytes, 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
});

/** SPA shell for the console. */
app.get("/admin/*", (c) => c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url), c.req.raw)));
app.get("/admin", (c) => c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url), c.req.raw)));
app.get("/assets/*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.route("/", publicRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ level: "error", message: err.message }));
  return c.json({ error: "internal_error" }, 500);
});

export default app;
