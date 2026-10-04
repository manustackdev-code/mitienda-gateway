const express = require("express");

const app = express();

const PORT = process.env.PORT || 10000;

const WORKER_BASE_URL = (
  process.env.WORKER_BASE_URL ||
  "https://mitienda-secure-api.manustackdev.workers.dev"
).replace(/\/+$/, "");

app.use(express.json({ limit: "150kb" }));

const ALLOWED_PATHS = new Set([
  "/v1/health",
  "/v1/catalog",
  "/v1/admin/catalog",
  "/v1/reserve-stock",
  "/v1/admin/images/imgbb",
]);

// CORS y preflight sin utilizar comodines incompatibles con Express 5.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Device-Id, X-Store-Id"
  );
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    gateway: "MiTienda Gateway",
    version: "1.0.0",
    status: "online",
  });
});

app.get("/gateway-health", (req, res) => {
  res.json({
    ok: true,
    gateway: "MiTienda Gateway",
    workerConfigured: Boolean(WORKER_BASE_URL),
    timestamp: new Date().toISOString(),
  });
});

// Express 5: el wildcard debe tener nombre.
app.all("/v1/{*splat}", async (req, res) => {
  try {
    const path = req.path;

    if (!ALLOWED_PATHS.has(path)) {
      return res.status(404).json({
        ok: false,
        error: "ROUTE_NOT_ALLOWED",
      });
    }

    const query = req.originalUrl.includes("?")
      ? req.originalUrl.slice(req.path.length)
      : "";

    const targetUrl = `${WORKER_BASE_URL}${req.path}${query}`;

    const headers = {
      Accept: req.get("Accept") || "application/json",
      "User-Agent": "MiTienda-Gateway/1.0",
    };

    const authorization = req.get("Authorization");
    const deviceId = req.get("X-Device-Id");
    const storeId = req.get("X-Store-Id");

    if (authorization) {
      headers.Authorization = authorization;
    }

    if (deviceId) {
      headers["X-Device-Id"] = deviceId;
    }

    if (storeId) {
      headers["X-Store-Id"] = storeId;
    }

    const options = {
      method: req.method,
      headers,
      redirect: "follow",
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      headers["Content-Type"] = "application/json";

      options.body = JSON.stringify(
        req.body && typeof req.body === "object"
          ? req.body
          : {}
      );
    }

    const response = await fetch(targetUrl, options);

    const body = await response.text();

    res.status(response.status);

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") ||
        "application/json; charset=utf-8"
    );

    return res.send(body);
  } catch (error) {
    console.error("Gateway error:", error);

    return res.status(502).json({
      ok: false,
      error: "GATEWAY_UPSTREAM_ERROR",
      message: String(error?.message || error),
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MiTienda Gateway escuchando en ${PORT}`);
  console.log(`Worker: ${WORKER_BASE_URL}`);
});
