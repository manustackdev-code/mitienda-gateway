import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const WORKER_BASE_URL = String(
  process.env.WORKER_BASE_URL || "https://mitienda-secure-api.manustackdev.workers.dev",
).replace(/\/+$/, "");
// The Worker accepts at most 13.5 million Base64 characters. 18 MiB leaves
// enough room for JSON framing while rejecting unbounded upload requests.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "18mb";
const GATEWAY_VERSION = "1.2.0";

app.disable("x-powered-by");
app.set("trust proxy", 1);

// Apply CORS before the JSON parser so browser/WebView clients can read 413s.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Accept, Content-Type, Authorization, X-Device-Id, X-Store-Id",
  );
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json({
  limit: JSON_BODY_LIMIT,
  strict: true,
  type: ["application/json", "application/*+json"],
}));

const health = (_req, res) => res.json({
  ok: true,
  gateway: "MiTienda Gateway",
  version: GATEWAY_VERSION,
  status: "online",
  jsonBodyLimit: JSON_BODY_LIMIT,
});
app.get("/", health);
app.get("/health", health);

const allowedRoutes = new Set([
  "GET /v1/health",
  "GET /v1/catalog",
  "PUT /v1/admin/catalog",
  "POST /v1/reserve-stock",
  "POST /v1/admin/images/imgbb",
]);

app.all("/v1/{*splat}", async (req, res) => {
  const pathname = new URL(req.originalUrl, "http://gateway.local").pathname;
  const routeKey = `${req.method.toUpperCase()} ${pathname}`;

  if (!allowedRoutes.has(routeKey)) {
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(req.originalUrl, `${WORKER_BASE_URL}/`);
    if (upstreamUrl.origin !== new URL(WORKER_BASE_URL).origin) {
      return res.status(400).json({ ok: false, error: "INVALID_UPSTREAM" });
    }
  } catch {
    return res.status(500).json({ ok: false, error: "INVALID_WORKER_BASE_URL" });
  }

  const headers = new Headers();
  for (const name of ["accept", "content-type", "authorization", "x-device-id", "x-store-id"]) {
    const value = req.get(name);
    if (value) headers.set(name, value);
  }

  const init = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  };

  if (!["GET", "HEAD"].includes(req.method.toUpperCase())) {
    init.body = JSON.stringify(req.body ?? {});
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
  }

  try {
    const upstream = await fetch(upstreamUrl, init);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.status(upstream.status).send(bytes);
  } catch (error) {
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Gateway upstream request failed", {
      route: routeKey,
      reason: isTimeout ? "timeout" : String(error?.message || error),
    });
    res.status(isTimeout ? 504 : 502).json({
      ok: false,
      error: isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      message: isTimeout
        ? "El servidor tardó demasiado en procesar la solicitud. Intenta otra vez."
        : "No se pudo conectar con el servidor de la tienda.",
    });
  }
});

// Report an actionable JSON error on oversized uploads instead of the generic
// HTML 'Payload Too Large' response, and keep CORS headers for WebView clients.
app.use((err, req, res, _next) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    const length = Number(err?.length || req.get("content-length") || 0);
    console.warn("Gateway rejected oversized request", {
      route: `${req.method} ${req.path}`,
      limit: JSON_BODY_LIMIT,
      bytesReported: length || undefined,
    });
    return res.status(413).json({
      ok: false,
      error: "REQUEST_TOO_LARGE",
      message: `La solicitud supera el límite del Gateway (${JSON_BODY_LIMIT}). Comprueba que Render tenga desplegada la versión ${GATEWAY_VERSION}.`,
      limit: JSON_BODY_LIMIT,
      bytesReported: length || null,
    });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ ok: false, error: "INVALID_JSON", message: "El JSON recibido no es válido." });
  }
  console.error("Gateway error", String(err?.message || err));
  return res.status(500).json({ ok: false, error: "GATEWAY_ERROR", message: "Error interno del Gateway." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MiTienda Gateway v${GATEWAY_VERSION} listening on ${PORT}; JSON body limit=${JSON_BODY_LIMIT}`);
});
