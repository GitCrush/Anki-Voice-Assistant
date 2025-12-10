// server/index.js
// Requires Node 18+ (built-in fetch)

import http from "node:http";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import Replicate from "replicate";
import { reviewChat, startConversation, sendConversation, resetConversation } from "./gpt.js";
import FormData from "form-data";


dotenv.config();

const ANKI_URL = process.env.ANKI_URL || "http://127.0.0.1:8765";
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(morgan("dev"));

// Disable keep-alive to reduce ECONNRESET / "socket hang up" on localhost
const agent = new http.Agent({ keepAlive: false });

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN   // put your token in .env
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// find first http(s) URL anywhere (prefer .mp3)
function findAnyUrl(node) {
  const urls = [];
  (function walk(v) {
    if (v == null) return;
    if (typeof v === "string") { if (/^https?:\/\//i.test(v)) urls.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "object") { Object.values(v).forEach(walk); }
  })(node);
  const mp3 = urls.find(u => /\.mp3(\?|$)/i.test(u));
  return mp3 || urls[0] || null;
}

// Normalize any model output to a string URL
function normalizeUrlFromOutput(out) {
  // Case 0: some SDK builds expose a function url() → URL or string
  if (out && typeof out === "object" && typeof out.url === "function") {
    try {
      const u = out.url();
      if (u && typeof u === "object" && typeof u.href === "string") return u.href; // URL instance
      if (typeof u === "string") return u;
    } catch {}
  }

  // Case 1: directly a string
  if (typeof out === "string") return out;

  // Case 2: array of strings
  if (Array.isArray(out)) return out[0] || null;

  // Case 3: object with url/audio/output
  if (out && typeof out === "object") {
    if (typeof out.url === "string") return out.url;
    if (typeof out.audio === "string") return out.audio;
    if (Array.isArray(out.output) && out.output[0]) return out.output[0];
  }

  // Case 4: last-resort deep scan for any http(s) URL (prefer .mp3)
  const urls = [];
  (function walk(v) {
    if (v == null) return;
    if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") Object.values(v).forEach(walk);
  })(out);
  return urls.find(u => /\.mp3(\?|$)/i.test(u)) || urls[0] || null;
}

// Return candidate upcoming card IDs for a deck (speculative prefetch)
app.get("/api/candidates", async (req, res) => {
  try {
    const deckName = String(req.query.deckName || "");
    const limit = Math.max(1, Math.min(20, Number(req.query.limit || 10)));

    if (!deckName) return res.status(400).json({ ok: false, error: "deckName required" });

    const query = `deck:"${deckName}" (is:due OR is:new OR is:learn)`;
    const ids = await ankiInvoke("findCards", { query });

    // Simple heuristic: return first N (you can randomize if your deck is “random order”)
    res.json({ ok: true, cardIds: (ids || []).slice(0, limit) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/cardsInfo", async (req, res) => {
  try {
    const ids = req.body?.cards || [];
    const info = await ankiInvoke("cardsInfo", { cards: ids });
    res.json(info || []);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


app.post("/api/tts", async (req, res) => {
  try {
    if (!process.env.REPLICATE_API_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing REPLICATE_API_TOKEN" });
    }

    const {
      text,
      emotion = "happy",
      voice_id = "Friendly_Person",
      language_boost = "German",
      english_normalization = true,
      pitch = 0, speed = 1, volume = 1, bitrate = 128000, channel = "mono", sample_rate = 32000
    } = req.body || {};

    if (!text?.trim()) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }

    const MAX = 4800;
    const safeText = text.length > MAX ? (text.slice(0, MAX - 1) + "…") : text;

    const input = {
      text: safeText, emotion, voice_id, language_boost, english_normalization,
      pitch, speed, volume, bitrate, channel, sample_rate
    };

    console.log("[TTS] Sanitized text:", safeText);

    const out = await replicate.run("minimax/speech-02-hd", { input });

    // DEBUG: show the shape once
    try {
      console.log("[TTS] typeof:", typeof out, "isArray:", Array.isArray(out));
      if (out && typeof out === "object") {
        console.log("[TTS] keys:", Object.keys(out));
      }
    } catch {}

    const url = normalizeUrlFromOutput(out);
    if (!url) {
      return res.status(502).json({
        ok: false,
        error: "No URL from Replicate output",
        debug: (() => { try { return JSON.stringify(out).slice(0, 800); } catch { return String(out); } })()
      });
    }


    return res.json({ ok: true, url }); // <- always a string
  } catch (e) {
    console.error("TTS error:", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


app.post("/api/review-chain", async (req, res) => {
  try {
    console.log("[/api/review-chain] invoked");
    const { audioBase64, front, back, language } = req.body || {};
    if (!audioBase64 || !front) {
      return res.status(400).json({ ok: false, error: "audioBase64 and front required" });
    }

    // Decide input mode: data URI (fast path) vs upload to files (fallback for big audio)
    const approxBytes = Math.round((String(audioBase64).length / 4) * 3);
    console.log("  audio size ~", Math.round(approxBytes / 1024), "KB");

    let audioInput = audioBase64; // default: pass data URI directly to the model (works < ~1 MB)

    if (approxBytes >= 1_000_000) {
      // Fallback: for larger recordings, upload to /v1/files and pass the returned URL
      console.log("  large audio, uploading to Replicate Files…");
      audioInput = await uploadToReplicateFilesFromDataUrl(audioBase64, "utterance.webm");
      console.log("  uploaded file:", audioInput);
    }

    // Whisper STT (pinned version)
    const MODEL = "vaibhavs10/incredibly-fast-whisper:3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c";
    const sttOut = await replicate.run(MODEL, {
      input: {
        task: "transcribe",
        audio: audioInput,               // <-- data URI or uploaded URL
        batch_size: 64,
        return_timestamps: false,
        language: language || undefined,
        temperature: 0,
      },
    });

    // Normalize transcript
    const transcript = (() => {
      const out = sttOut;
      if (!out) return "";
      if (typeof out === "string") return out.trim();
      if (Array.isArray(out)) {
        if (typeof out[0] === "string") return out.join(" ").trim();
        const joined = out.map(s => s?.text ?? "").join(" ").trim();
        if (joined) return joined;
      }
      if (typeof out === "object") {
        if (typeof out.text === "string") return out.text.trim();
        if (Array.isArray(out.segments)) return out.segments.map(s => s?.text ?? "").join(" ").trim();
      }
      return "";
    })();

    // Review via Replicate GPT (your gpt.js uses replicate.stream)
    const reply = await reviewChat({ front, back, transcript });

    return res.json({ ok: true, transcript, reply });
  } catch (e) {
    console.error("review-chain error:", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});



// Start or re-seed a conversation
// body: { sessionId, system?, seedContext? }
app.post("/api/conversation/start", (req, res) => {
  try {
    const { sessionId, system, seedContext } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId required" });
    const out = startConversation({ sessionId, system, seedContext });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Send a user message in an existing conversation
// body: { sessionId, user }
app.post("/api/conversation/send", async (req, res) => {
  try {
    const { sessionId, user } = req.body || {};
    if (!sessionId || !user) return res.status(400).json({ ok: false, error: "sessionId and user required" });
    const { reply } = await sendConversation({ sessionId, user });
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Reset/end a conversation
// body: { sessionId }
app.post("/api/conversation/reset", (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId required" });
    const out = resetConversation({ sessionId });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


function normalizeTextFromOutput(out) {
  if (!out) return null;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    // some whisper forks return [ { text, ... } ] or [ "text" ]
    const first = out[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && typeof first.text === "string") return first.text;
  }
  if (typeof out === "object") {
    // common shapes
    if (typeof out.text === "string") return out.text;
    if (typeof out.transcription === "string") return out.transcription;
    if (Array.isArray(out.segments)) {
      const joined = out.segments.map(s => s.text || "").join(" ").trim();
      if (joined) return joined;
    }
  }
  return null;
}

async function ankiInvoke(action, params = {}, { retries = 2 } = {}) {
  const payload = { action, version: 6, params };
  try {
    const res = await fetch(ANKI_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
      agent
    });
    if (!res.ok) throw new Error(`AnkiConnect HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`AnkiConnect: ${json.error}`);
    return json.result;
  } catch (err) {
    const msg = String(err?.message || err);
    if (
      retries > 0 &&
      (msg.includes("socket hang up") ||
       msg.includes("ECONNRESET") ||
       msg.includes("timeout"))
    ) {
      await new Promise(r => setTimeout(r, 200));
      return ankiInvoke(action, params, { retries: retries - 1 });
    }
    throw err;
  }
}

/** Health check + version */
app.get("/api/health", async (_req, res) => {
  try {
    const version = await ankiInvoke("version");
    res.json({ ok: true, ankiVersion: version });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** List deck names */
app.get("/api/decks", async (_req, res) => {
  try {
    let names = await ankiInvoke("deckNames");
    if (!Array.isArray(names) || names.length === 0) {
      // fallback for older/edge cases
      const map = await ankiInvoke("deckNamesAndIds");
      names = Object.keys(map || {});
    }
    res.json({ ok: true, decks: names || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Start review for a deck; returns started:true if reviewer becomes active */
app.post("/api/start", async (req, res) => {
  try {
    const { deckName } = req.body;
    if (!deckName) return res.status(400).json({ ok: false, error: "deckName required" });

    // Optional sanity check: deck exists
    const names = await ankiInvoke("deckNames");
    if (!names.includes(deckName)) {
      return res.json({ ok: false, error: `Deck not found: ${deckName}` });
    }

    // Open the reviewer for the deck (works even with only 'New' cards)
    await ankiInvoke("guiDeckReview", { name: deckName });

    // Poll briefly to see if reviewer became active (Anki may show overview first)
    const deadline = Date.now() + 1200;
    let active = false;
    while (Date.now() < deadline) {
      try {
        const cur = await ankiInvoke("guiCurrentCard");
        if (cur && (cur.cardId || cur.question)) { active = true; break; }
      } catch (_) {
        // not active yet; wait a tick
      }
      await new Promise(r => setTimeout(r, 120));
    }

    if (!active) {
      return res.json({ ok: true, started: false, reason: "reviewer_inactive_or_overview" });
    }
    res.json({ ok: true, started: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Get the current card (rendered HTML + raw fields) */
app.get("/api/current", async (_req, res) => {
  try {
    let cur;
    try {
      cur = await ankiInvoke("guiCurrentCard");
    } catch (e) {
      if (String(e.message).includes("Gui review is not currently active")) {
        return res.json({ ok: true, empty: true, reason: "reviewer_inactive" });
      }
      throw e;
    }

    if (!cur) return res.json({ ok: true, empty: true });

    const cardId = cur.cardId;
    const frontHTML = cur.question || "";
    const backHTML  = cur.answer || "";

    const info = await ankiInvoke("cardsInfo", { cards: [cardId] });
    const fields = info?.[0]?.fields || {};
    const modelName = info?.[0]?.modelName || "";
    const templateName = cur.template || cur.templateName || "";

    res.json({ ok: true, cardId, modelName, templateName, frontHTML, backHTML, fields });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Force reviewer for deck, then flip front/back (full mirror) */
app.post("/api/show", async (req, res) => {
  try {
    const { side, deckName } = req.body; // side: "front" | "back"
    if (side !== "front" && side !== "back") {
      return res.status(400).json({ ok: false, error: "side must be 'front' or 'back'" });
    }

    if (deckName) {
      // Re-open the reviewer for this deck to ensure main window is in review mode
      await ankiInvoke("guiDeckReview", { name: deckName });
    }

    // Poll briefly until reviewer is active (not overview/browser)
    const deadline = Date.now() + 1000;
    let active = false;
    while (Date.now() < deadline) {
      try {
        const cur = await ankiInvoke("guiCurrentCard");
        if (cur && (cur.cardId || cur.question)) { active = true; break; }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 120));
    }

    // Flip side if we’re active (if not, still attempt; Anki may ignore)
    if (side === "front") await ankiInvoke("guiShowQuestion");
    else await ankiInvoke("guiShowAnswer");

    return res.json({ ok: true, reviewerActive: active });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


/** Submit ease (Again=1, Hard=2, Good=3, Easy=4) */
app.post("/api/answer", async (req, res) => {
  try {
    const { ease } = req.body;
    const n = Number(ease);
    if (![1, 2, 3, 4].includes(n)) {
      return res.status(400).json({ ok: false, error: "ease must be 1..4" });
    }

    // Ensure we're on the back (Anki requires this to register an answer)
    try {
      await ankiInvoke("guiShowAnswer");
      await sleep(120); // give Anki a beat to switch UI state
    } catch (_) {
      // ignore; if already on back, or Anki ignores, we'll still try to answer
    }

    await ankiInvoke("guiAnswerCard", { ease: n });

    // Optional: nudge reviewer to show the NEXT front right away
    try {
      await sleep(80);
      await ankiInvoke("guiShowQuestion");
    } catch (_) {}

    res.json({ ok: true });
  } catch (e) {
    console.error("answer error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// --- Helper: upload a data: URL to Replicate Files (using 'form-data') ---
async function uploadToReplicateFilesFromDataUrl(dataUrl, filename = "utterance.webm") {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("Missing REPLICATE_API_TOKEN");

  // Extract content type + base64 from data URL
  const m = String(dataUrl).match(/^data:([^;,]+)[^,]*,([A-Za-z0-9+/=_-]+)$/);
  if (!m) throw new Error("Invalid data URL for audio");
  const contentType = m[1] || "application/octet-stream";
  const base64 = m[2];
  const buf = Buffer.from(base64, "base64");

  // Build classic multipart form with explicit filename + content type
  const form = new FormData();
  form.append("file", buf, { filename, contentType, knownLength: buf.length });

  // NOTE: we must pass form.getHeaders() so boundary is set correctly
  const up = await fetch("https://api.replicate.com/v1/files", {
    method: "POST",
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
    },
    // form is a stream; fetch will stream it correctly
    body: form,
  });

  if (!up.ok) {
    const t = await up.text().catch(() => "");
    throw new Error(`Replicate file upload failed (${up.status}): ${t}`);
  }
  const j = await up.json();
  if (!j?.url) throw new Error("Upload did not return a file URL");
  return j.url;
}

