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

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment");
  process.exit(1);
}

if (!process.env.ADMIN_RESET_KEY) {
  console.warn("Warning: ADMIN_RESET_KEY is not set. Admin reset routes will not work.");
}
const DEV_MODE_UNLIMITED_MAPS = process.env.DEV_MODE_UNLIMITED_MAPS === "true";
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

const ALLOWED_ORIGINS = [
  "https://kilgarde.studio",
  "https://www.kilgarde.studio",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

const MAX_REQUESTS_PER_DAY = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const requestCounts = new Map();
const mapCache = new Map();

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-admin-reset-key"
  );
  res.header("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("."));

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
  if (DEV_MODE_UNLIMITED_MAPS) {
    return 999;
  }

  const key = getClientKey(req);
  const timestamps = pruneOldTimestamps(requestCounts.get(key) || []);
  requestCounts.set(key, timestamps);
  return Math.max(0, MAX_REQUESTS_PER_DAY - timestamps.length);
}

function consumeRequest(req) {
  if (DEV_MODE_UNLIMITED_MAPS) {
    return true;
  }

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

function consumeRequest(req) {
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

function buildMapPrompt({
  title = "Untitled Scenario",
  locationType = "random",
  threatType = "random",
  objectiveType = "random",
  location = "",
  terrain = [],
  map = "",
  twist = "",
  escalation = ""
}) {
  const terrainText = Array.isArray(terrain)
    ? terrain.join(", ")
    : String(terrain || "");

  return `
Generate a top-down tactical tabletop battle map for a grim medieval fantasy skirmish game.

This map must represent a full 4'x4' Mordheim-style board, not a compact 2'x2' skirmish layout.

Scale and layout requirements:
- The board must feel spacious and spread across a full 4'x4' play area.
- Terrain should be distributed across the whole table, not compressed into a tiny central cluster.
- Leave meaningful open movement lanes between major terrain pieces.
- Use dense terrain overall, but with realistic spacing so warbands can manoeuvre, flank, and reposition.
- Avoid the feel of a tight arena, corridor map, or tiny boxed encounter zone.
- Buildings, ruins, barriers, and elevation should feel like parts of a larger battlefield, not oversized features consuming the whole board.
- The central structure or objective area should occupy roughly 15-20% of the board, not dominate the full map.
- Include outer-table terrain so the board edges feel usable for deployment and movement.

Composition requirements:
- Strict top-down view
- No perspective
- No characters, creatures, or miniatures
- No labels, text, UI, borders, or icons
- Printable, readable terrain shapes
- Grayscale, parchment, or muted natural tones
- Suitable for a ruined city / roadside / defensive skirmish environment

STRUCTURE BALANCE:
- Include ONE dominant terrain feature (large ruin, structure, or strongpoint)
- Include 2-3 medium terrain clusters positioned asymmetrically
- Include several small scatter groupings across the outer board
- Do NOT make all terrain pieces similar in size or importance

SPACING:
- Avoid evenly spacing terrain across the board
- Create dense zones (clustered terrain) and sparse zones (open ground)
- Ensure at least one quadrant of the board is relatively open
- Outer board edges must remain usable for movement and deployment

Gameplay requirements:
- Include multiple possible movement lanes, not just 2 forced routes
- At least 3 meaningful avenues of approach across the board
- A central point of interest tied to the scenario objective
- Several vertical or defensive terrain features across the board
- Scattered cover in the outer thirds of the map
- A few longer sightlines, but not a fully open board
- Terrain density should fit Mordheim: cluttered, broken, tactical, vertical, but still navigable

Board feel:
- This should look like a full tabletop board that players populate with warbands
- Not a single puzzle encounter area
- Not a tight chokepoint-only design
- Not a tiny competitive lane map
- Think larger ruined district, toll crossing, roadside hold, or broken approach route across a 4'x4' table

Scenario title:
${title}

Location type:
${locationType}

Threat type:
${threatType}

Objective type:
${objectiveType}

Location description:
${location}

Terrain requirements:
${terrainText}

Table setup sketch:
${map}

Twist influence:
${twist}

Escalation influence:
${escalation}

Output one printable top-down tactical map image sized and composed for a full 4'x4' tabletop scenario.
  `.trim();
}

app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "kilgarde-backend"
  });
});

app.get("/api/health", (req, res) => {
  return res.json({
    ok: true,
    service: "kilgarde-backend"
  });
});

app.get("/api/map-credits", (req, res) => {
  return res.json({
    remainingToday: getRemainingRequests(req),
    dailyLimit: MAX_REQUESTS_PER_DAY
  });
});

app.post("/api/admin/reset-map-credits", (req, res) => {
  const adminKey = req.headers["x-admin-reset-key"];

  if (!process.env.ADMIN_RESET_KEY || adminKey !== process.env.ADMIN_RESET_KEY) {
    return res.status(403).json({
      error: "Forbidden"
    });
  }

  const key = getClientKey(req);
  requestCounts.delete(key);

  console.log(`[ADMIN RESET] Credits reset for client ${key}`);

  return res.json({
    success: true,
    message: "Map credits reset for this client",
    remainingToday: MAX_REQUESTS_PER_DAY,
    dailyLimit: MAX_REQUESTS_PER_DAY
  });
});

app.post("/api/admin/reset-all-map-credits", (req, res) => {
  const adminKey = req.headers["x-admin-reset-key"];

  if (!process.env.ADMIN_RESET_KEY || adminKey !== process.env.ADMIN_RESET_KEY) {
    return res.status(403).json({
      error: "Forbidden"
    });
  }

  requestCounts.clear();

  console.log("[ADMIN RESET] Credits reset for all clients");

  return res.json({
    success: true,
    message: "Map credits reset for all clients",
    remainingToday: MAX_REQUESTS_PER_DAY,
    dailyLimit: MAX_REQUESTS_PER_DAY
  });
});

app.post("/api/generate-map", async (req, res) => {
  try {
    const {
      title,
      locationType = "random",
      threatType = "random",
      objectiveType = "random",
      location = "",
      terrain = [],
      map = "",
      twist = "",
      escalation = ""
    } = req.body ?? {};

    if (!title) {
      return res.status(400).json({
        error: "Missing required field: title"
      });
    }

    const normalizedPayload = {
      title,
      locationType,
      threatType,
      objectiveType,
      location,
      terrain: Array.isArray(terrain) ? terrain : [],
      map,
      twist,
      escalation
    };

    const cacheKey = buildCacheKey(normalizedPayload);

    if (mapCache.has(cacheKey)) {
      console.log(`[MAP CACHE HIT] ${title}`);

      return res.json({
        ...mapCache.get(cacheKey),
        cached: true,
        remainingToday: getRemainingRequests(req),
        dailyLimit: MAX_REQUESTS_PER_DAY
      });
    }

    if (!consumeRequest(req)) {
      console.log(`[MAP RATE LIMITED] ${title}`);

      return res.status(429).json({
        error: "Daily map allowance used. Try again tomorrow.",
        remainingToday: 0,
        dailyLimit: MAX_REQUESTS_PER_DAY
      });
    }

    console.log(`[MAP GENERATE] ${title}`);

    const prompt = buildMapPrompt(normalizedPayload);

    const response = await client.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024"
    });

    const imageBase64 = response?.data?.[0]?.b64_json;

    if (!imageBase64) {
      return res.status(502).json({
        error: "No image returned from OpenAI."
      });
    }

    const result = {
      mimeType: "image/png",
      imageBase64
    };

    mapCache.set(cacheKey, result);

    return res.json({
      ...result,
      cached: false,
      remainingToday: getRemainingRequests(req),
      dailyLimit: MAX_REQUESTS_PER_DAY
    });
  } catch (error) {
    console.error("Map generation failed:", error?.message || "Unknown error");

    return res.status(500).json({
      error: error?.message || "Map generation failed"
    });
  }
});

app.post("/api/track", async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        error: "Analytics database not configured"
      });
    }

    const {
      tool_name,
      tool_version,
      event_type,
      session_id,
      page_url,
      metadata
    } = req.body || {};

    if (!tool_name || !event_type) {
      return res.status(400).json({
        error: "tool_name and event_type required"
      });
    }

    await pool.query(
      `
      INSERT INTO tool_events (
        tool_name,
        tool_version,
        event_type,
        session_id,
        page_url,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        tool_name,
        tool_version || null,
        event_type,
        session_id || null,
        page_url || null,
        metadata || {}
      ]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("TRACK ERROR:", err);
    return res.status(500).json({ error: "failed" });
  }
});

app.get("/api/metrics/summary", async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        error: "Analytics database not configured"
      });
    }

    const result = await pool.query(`
      SELECT
        event_type,
        COUNT(*)::int as count
      FROM tool_events
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY event_type
      ORDER BY count DESC
    `);

    return res.json(result.rows);
  } catch (err) {
    console.error("METRICS ERROR:", err);
    return res.status(500).json({
      error: "failed",
      detail: err.message
    });
  }
});

app.listen(port, () => {
  console.log(`Kilgarde server running at http://localhost:${port}`);
});
app.get("/api/metrics/dashboard", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ error: "Analytics database not configured" });
  }

  try {
    const totalEvents = await pool.query(`
      SELECT COUNT(*) FROM tool_events;
    `);

    const sessions = await pool.query(`
      SELECT COUNT(DISTINCT session_id) FROM tool_events;
    `);

    const eventsByType = await pool.query(`
      SELECT event_type, COUNT(*) as count
      FROM tool_events
      GROUP BY event_type;
    `);

    const conversion = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'generate_success')::float /
        NULLIF(COUNT(*) FILTER (WHERE event_type = 'generate_clicked'), 0)
        AS conversion_rate
      FROM tool_events;
    `);

    const daily = await pool.query(`
      SELECT
        DATE_TRUNC('day', created_at) AS day,
        COUNT(*) AS total_events,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(*) FILTER (WHERE event_type = 'generate_success') AS generates
      FROM tool_events
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30;
    `);

    res.json({
      totalEvents: Number(totalEvents.rows[0].count),
      sessions: Number(sessions.rows[0].count),
      conversionRate: conversion.rows[0].conversion_rate || 0,
      eventsByType: eventsByType.rows,
      daily: daily.rows
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed" });
  }
});
