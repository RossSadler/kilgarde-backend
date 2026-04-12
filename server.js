import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- ENV VALIDATION ---
if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment");
  process.exit(1);
}

if (!process.env.ADMIN_RESET_KEY) {
  console.warn("Warning: ADMIN_RESET_KEY is not set. Admin reset routes will not work.");
}

// --- DEV MODE ---
const DEV_MODE_UNLIMITED_MAPS =
  String(process.env.DEV_MODE_UNLIMITED_MAPS).toLowerCase() === "true";

// --- OPENAI ---
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --- DATABASE (OPTIONAL) ---
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

// --- CORS (CLEAN SINGLE CONFIG) ---
const ALLOWED_ORIGINS = [
  "https://kilgarde.studio",
  "https://www.kilgarde.studio",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-reset-key"]
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.static("."));

// --- RATE LIMIT ---
const MAX_REQUESTS_PER_DAY = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const requestCounts = new Map();
const mapCache = new Map();

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function pruneOldTimestamps(timestamps) {
  const now = Date.now();
  return timestamps.filter((ts) => now - ts < DAY_MS);
}

function getRemainingRequests(req) {
  if (DEV_MODE_UNLIMITED_MAPS) return 999;

  const key = getClientKey(req);
  const timestamps = pruneOldTimestamps(requestCounts.get(key) || []);
  requestCounts.set(key, timestamps);

  return Math.max(0, MAX_REQUESTS_PER_DAY - timestamps.length);
}

function consumeRequest(req) {
  if (DEV_MODE_UNLIMITED_MAPS) return true;

  const key = getClientKey(req);
  const now = Date.now();
  const timestamps = pruneOldTimestamps(requestCounts.get(key) || []);

  if (timestamps.length >= MAX_REQUESTS_PER_DAY) {
    requestCounts.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  requestCounts.set(key, timestamps);
  return true;
}

function buildCacheKey(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

// --- HEALTH ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "kilgarde-backend" });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// --- MAP CREDITS ---
app.get("/api/map-credits", (req, res) => {
  res.json({
    remainingToday: getRemainingRequests(req),
    dailyLimit: DEV_MODE_UNLIMITED_MAPS ? 999 : MAX_REQUESTS_PER_DAY,
    devMode: DEV_MODE_UNLIMITED_MAPS
  });
});

// --- ADMIN RESET ---
app.post("/api/admin/reset-map-credits", (req, res) => {
  const key = req.headers["x-admin-reset-key"];

  if (!process.env.ADMIN_RESET_KEY || key !== process.env.ADMIN_RESET_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }

  requestCounts.delete(getClientKey(req));

  res.json({ success: true });
});

// --- MAP GENERATION ---
app.post("/api/generate-map", async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.title) {
      return res.status(400).json({ error: "Missing title" });
    }

    const cacheKey = buildCacheKey(payload);

    // CACHE HIT
    if (mapCache.has(cacheKey)) {
      return res.json({
        ...mapCache.get(cacheKey),
        cached: true,
        remainingToday: getRemainingRequests(req),
        dailyLimit: DEV_MODE_UNLIMITED_MAPS ? 999 : MAX_REQUESTS_PER_DAY,
        devMode: DEV_MODE_UNLIMITED_MAPS
      });
    }

    // RATE LIMIT
    if (!consumeRequest(req)) {
      return res.status(429).json({
        error: "Daily map limit reached",
        remainingToday: 0,
        dailyLimit: MAX_REQUESTS_PER_DAY
      });
    }

    const response = await client.images.generate({
      model: "gpt-image-1",
      prompt: `Top-down tactical tabletop map for a 4x4 Mordheim-style board. ${payload.title}`,
      size: "1024x1024"
    });

    const imageBase64 = response?.data?.[0]?.b64_json;

    if (!imageBase64) {
      return res.status(500).json({ error: "No image returned" });
    }

    const result = {
      mimeType: "image/png",
      imageBase64
    };

    mapCache.set(cacheKey, result);

    res.json({
      ...result,
      cached: false,
      remainingToday: getRemainingRequests(req),
      dailyLimit: DEV_MODE_UNLIMITED_MAPS ? 999 : MAX_REQUESTS_PER_DAY,
      devMode: DEV_MODE_UNLIMITED_MAPS
    });

  } catch (err) {
    console.error("Map generation failed:", err);
    res.status(500).json({ error: "Map generation failed" });
  }
});

// --- ANALYTICS ---
app.post("/api/track", async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DB not configured" });
  }

  try {
    const { tool_name, event_type } = req.body;

    if (!tool_name || !event_type) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await pool.query(
      `INSERT INTO tool_events (tool_name, event_type) VALUES ($1, $2)`,
      [tool_name, event_type]
    );

    res.json({ ok: true });

  } catch (err) {
    console.error("TRACK ERROR:", err);
    res.status(500).json({ error: "failed" });
  }
});

// --- START ---
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
