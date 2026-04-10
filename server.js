import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const allowedOrigins = [
  "https://kilgarde.studio",
  "https://www.kilgarde.studio",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static("."));

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
Generate a top-down tactical tabletop skirmish map for a grim, grounded medieval fantasy setting.

This must be a gameplay layout, not concept art.

Hard layout rules:

The map must clearly show three distinct gameplay zones:

1. Entry Zone (bottom 20%)
- visibly open
- minimal cover
- clearly readable as deployment space

2. Conflict Zone (middle 50-60%)
- dense terrain
- strong central structure such as a ruin, gatehouse, toll point, or hold
- main combat area

3. Objective / Exit Zone (top 20%)
- must be immediately readable as the objective area at a glance

The top zone MUST include a clearly defined focal element such as:
- a gate, arch, or exit point
- a raised platform or hill
- a distinct structure
- a wall line or terrain boundary

The player must instantly understand:
"this is where I am trying to reach"

The map MUST contain exactly two dominant routes from the entry zone to the objective zone.

Route 1: Direct Path
- must be the most obvious and visually dominant route
- must pass through a tight choke point
- must be narrow, constrained, and exposed
- must represent the fastest way to the objective

Route 2: Flank Path
- must clearly branch away from the direct path early
- must remain separate for most of the map
- must rejoin near the objective zone
- must be longer but provide more cover or safety

The two routes must be clearly separated in space and must not overlap.

No third route should compete in importance.
Small debris paths or gaps may exist but must not function as full alternative routes.

The player must instantly see:
- the fast dangerous route
- the slower safer route

The central structure must physically block movement and force the separation of the two routes.

You MUST include:
- one strong choke point that restricts movement to a narrow passage such as a doorway, gate, breach, or tight corridor
- the choke point must sit between the entry zone and the objective zone
- the choke point must be unavoidable on the direct route
- one flank route that bypasses the choke point
- one open danger area with low cover and high exposure
- one dense cover area with walls, rubble, debris, or heavy scatter

Interior spaces must include partial obstructions, broken walls, or debris to prevent large empty areas.

The layout must create a clear flow:
entry -> approach -> conflict -> exit

The player path should naturally guide movement from bottom to top.

Avoid circular layouts or evenly distributed terrain.
The map must funnel movement into the two defined routes.

Avoid aesthetic symmetry or decorative layouts.
Prioritize gameplay clarity over visual beauty.

Visual rules:
- strict top-down view
- no perspective
- no characters or creatures
- no tokens or miniatures
- no labels or text
- no UI elements
- no borders
- clean, readable terrain shapes
- muted parchment, grayscale, or subdued natural tones
- must be clearly usable when printed

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

Output a single printable tactical battle map image.
  `.trim();
}

app.post("/api/generate-map", async (req, res) => {
  console.log("---- /api/generate-map called ----");
  console.log("Incoming payload:", JSON.stringify(req.body, null, 2));

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

    const prompt = buildMapPrompt({
      title,
      locationType,
      threatType,
      objectiveType,
      location,
      terrain,
      map,
      twist,
      escalation
    });

    console.log("Prompt built successfully.");
    console.log("Calling OpenAI Images API...");

    const response = await client.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024"
    });

    const imageBase64 = response?.data?.[0]?.b64_json;

    if (!imageBase64) {
      console.error("No image returned from OpenAI.");
      console.error("Raw response:", JSON.stringify(response, null, 2));

      return res.status(502).json({
        error: "No image returned from OpenAI."
      });
    }

    return res.json({
      mimeType: "image/png",
      imageBase64
    });
  } catch (error) {
    console.error("Map generation failed.");
    console.error("Message:", error?.message || "Unknown error");
    console.error("Status:", error?.status || "none");

    if (error?.response) {
      console.error("Response:", JSON.stringify(error.response, null, 2));
    }

    return res.status(500).json({
      error: error?.message || "Map generation failed"
    });
  }
});

app.listen(port, () => {
  console.log("Kilgarde server running at http://localhost:" + port);
});
