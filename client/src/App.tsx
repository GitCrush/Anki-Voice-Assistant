// client/src/App.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import * as API from "./api";
import { SpeechOnce } from "./stt";
import { extractFieldHTML, toPlainSpeakable } from "./sanitize";

type Msg = { role: "assistant" | "user"; text?: string; html?: string };

export default function App() {
  // ---------- Deck / session ----------
  const [decks, setDecks] = useState<string[]>([]);
  const [deck, setDeck] = useState<string>(() => localStorage.getItem("deck") || "");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [current, setCurrent] = useState<API.CurrentCard | null>(null);
  const [loading, setLoading] = useState(false);

  // ---------- Audio / TTS ----------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [ttsUrl, setTtsUrl] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [allowAutoplay, setAllowAutoplay] = useState(false);
  const lastGestureRef = useRef(0);

  const ttsCache = useRef<Map<number, string>>(new Map());
  const inflight = useRef<Set<number>>(new Set());
  const MAX_CACHE = 12;
  const PREFETCH_COUNT = 5;
  const CONCURRENCY = 4;

  // ---------- STT ----------
  const sttLockRef = useRef(false);
  const [recState, setRecState] = useState<"idle" | "listening" | "recording">("idle");

  // ---------- Conversation (free chat) ----------
  const [chatMode, setChatMode] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const sessionIdRef = useRef<string>(
    (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  );

  // ---------- Sequencing guard ----------
  const currentSeqRef = useRef(0);

  // ---------- Load decks ----------
  useEffect(() => {
    API.decks()
      .then((r) => {
        if (r.ok && r.decks?.length) {
          setDecks(r.decks);
          if (!deck) {
            const initial = r.decks.includes("Default") ? "Default" : r.decks[0];
            setDeck(initial);
            localStorage.setItem("deck", initial);
          }
        } else {
          setDecks([]);
          console.warn("Decks error:", r.error || "No decks");
        }
      })
      .catch((e) => {
        console.error("Decks failed:", e);
        setDecks([]);
      });
  }, []); // eslint-disable-line

  useEffect(() => {
    if (deck) localStorage.setItem("deck", deck);
  }, [deck]);

  // ---------- Autoplay TTS ----------
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !ttsUrl) return;
    el.src = ttsUrl;
    el.muted = false;
    el.preload = "auto";

    const withinGesture = Date.now() - lastGestureRef.current < 5000;
    const tryPlay = () => el.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
    if (allowAutoplay || withinGesture) requestAnimationFrame(tryPlay);
    else setNeedsTap(true);

    return () => {
      try { if (ttsUrl.startsWith("blob:")) URL.revokeObjectURL(ttsUrl); } catch {}
    };
  }, [ttsUrl, allowAutoplay]);

  // ---------- Speakable preview ----------
  const ttsPreview = useMemo(() => {
    if (!current) return "";
    const html = extractFieldHTML(current.fields || {}, current.modelName, "front") || current.frontHTML || "";
    return toPlainSpeakable(html);
  }, [current]);

  // ---------- Utilities ----------
  function cacheSet(cardId: number, blobUrl: string) {
    if (!ttsCache.current.has(cardId)) {
      ttsCache.current.set(cardId, blobUrl);
      if (ttsCache.current.size > MAX_CACHE) {
        const oldest = ttsCache.current.keys().next().value as number;
        const oldUrl = ttsCache.current.get(oldest)!;
        try { if (oldUrl.startsWith("blob:")) URL.revokeObjectURL(oldUrl); } catch {}
        ttsCache.current.delete(oldest);
      }
    }
  }

  async function ttsFetchToBlobUrl(text: string): Promise<string | null> {
    if (!text) return null;
    const url = await API.tts(text);
    if (!url) return null;
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const blob = new Blob([buf], { type: "audio/mpeg" });
    return URL.createObjectURL(blob);
  }

  async function prefetchOneCard(cardId: number) {
    if (ttsCache.current.has(cardId) || inflight.current.has(cardId)) return;
    inflight.current.add(cardId);
    try {
      const infos = await API.cardsInfo([cardId]);
      const fields = infos?.[0]?.fields || {};
      const modelName = infos?.[0]?.modelName || "";
      const html = extractFieldHTML(fields, modelName, "front") || "";
      const speakable = toPlainSpeakable(html);
      console.log("[Prefetch speakable]", cardId, speakable.slice(0, 120));
      const blobUrl = await ttsFetchToBlobUrl(speakable);
      if (blobUrl) cacheSet(cardId, blobUrl);
    } catch (e) {
      console.warn("prefetch failed:", e);
    } finally {
      inflight.current.delete(cardId);
    }
  }

  async function warmPrefetch(deckName: string, excludeCardId?: number, n = PREFETCH_COUNT) {
    const cand = await API.candidates(deckName, 10);
    const list = (cand.ok && cand.cardIds ? cand.cardIds : [])
      .filter((id) => id !== excludeCardId)
      .slice(0, n);

    const queue = [...list];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
      workers.push(
        (async function run() {
          while (queue.length) {
            const id = queue.shift()!;
            await prefetchOneCard(id);
          }
        })()
      );
    }
    await Promise.all(workers);
  }

  async function ttsSpeakCardFront(cur: API.CurrentCard | null) {
    const snap = cur;
    if (!snap?.cardId) return;

    const cached = ttsCache.current.get(snap.cardId);
    if (cached) {
      setTtsUrl(cached);
    } else {
      const frontHTML =
        extractFieldHTML(snap.fields || {}, snap.modelName, "front") || snap.frontHTML || "";
      const speakable = toPlainSpeakable(frontHTML);
      console.log("[Sanitized front for TTS]", speakable);
      const blobUrl = await ttsFetchToBlobUrl(speakable);
      if (blobUrl) {
        cacheSet(snap.cardId, blobUrl);
        setTtsUrl(blobUrl);
      }
    }
    warmPrefetch(deck, snap.cardId, PREFETCH_COUNT).catch(() => {});
  }

  function waitForPlaybackToFinish(): Promise<void> {
    return new Promise((resolve) => {
      const el = audioRef.current;
      if (!el || !el.src) return resolve();
      if (el.ended || (Number.isFinite(el.duration) && el.currentTime >= el.duration - 0.01)) {
        return resolve();
      }
      const onEnded = () => {
        el.removeEventListener("ended", onEnded);
        resolve();
      };
      el.addEventListener("ended", onEnded);
    });
  }

  // ---------- STT → /api/review-chain (manual via button) ----------
  async function startListeningForAnswer(
    languageHint: string,
    snap: API.CurrentCard,
    seqAtStart: number
  ) {
    if (seqAtStart !== currentSeqRef.current) return;

    const stt = new SpeechOnce({
      rmsThreshold: 0.02,
      startFrames: 4,
      // 3s thinking pause handled by default endFrames in stt.ts
      maxUtteranceMs: 60000,
      onStartRecording: () => setRecState("recording"),
      onStopRecording: () => setRecState("idle"),
    });

    try {
      await waitForPlaybackToFinish();

      console.log("[STT] Opening mic…");
      await stt.start();
      setRecState("listening");
      const blob = await stt.recordOneUtterance();
      setRecState("idle");
      await stt.stop();

      if (!blob) {
        console.warn("[STT] No speech captured.");
        return;
      }
      console.log("[STT] Utterance size:", blob.size);

      const dataUrl = await SpeechOnce.blobToDataURL(blob);
      if (!dataUrl.startsWith("data:audio")) return;

      const frontFieldHTML =
        extractFieldHTML(snap?.fields || {}, snap?.modelName || "", "front") || snap?.frontHTML || "";
      const backFieldHTML =
        extractFieldHTML(snap?.fields || {}, snap?.modelName || "", "back") || snap?.backHTML || "";

      let frontTxt = toPlainSpeakable(frontFieldHTML || "");
      if (!frontTxt.trim()) frontTxt = "(front text missing)";
      const backTxt = toPlainSpeakable(backFieldHTML || "");

      if (seqAtStart !== currentSeqRef.current) return;

      console.log("[CHAIN] POST /api/review-chain …");
      const out = await API.reviewChain({
        audioBase64: dataUrl,
        front: frontTxt,
        back: backTxt,
        language: languageHint || "german",
      });
      console.log("[CHAIN] response:", out);

      if (out.ok) {
        setMessages((m) => [...m, { role: "user", text: out.transcript || "(no speech)" }]);
        if (out.reply) setMessages((m) => [...m, { role: "assistant", text: out.reply }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", text: out.error || "(review failed)" }]);
      }
    } catch (e) {
      setRecState("idle");
      console.error("STT failed:", e);
    } finally {
      try { await stt.stop(); } catch {}
    }
  }

  // ---------- Start / Grade / Show Back ----------
  async function handleStart() {
    if (!deck) {
      setMessages((m) => [...m, { role: "assistant", text: "Pick a deck first." }]);
      return;
    }
    lastGestureRef.current = Date.now();
    setAllowAutoplay(true);
    setLoading(true);
    setMessages([]);

    const startRes = await API.start(deck);
    if (startRes?.empty && !startRes?.started) {
      setMessages((m) => [...m, { role: "assistant", text: `No cards to review in “${deck}”.` }]);
      setLoading(false);
      return;
    }
    if (startRes?.ok === false && startRes?.error) {
      setMessages((m) => [...m, { role: "assistant", text: `Start error: ${startRes.error}` }]);
      setLoading(false);
      return;
    }

    const cur = await API.current();
    setCurrent(cur);
    currentSeqRef.current += 1;

    if (cur?.empty || !cur?.frontHTML) {
      setMessages((m) => [...m, { role: "assistant", text: "Reviewer not active." }]);
      setLoading(false);
      return;
    }

    setMessages((m) => [...m, { role: "assistant", html: cur.frontHTML }]);
    await API.show("front", deck).catch(() => {});
    await ttsSpeakCardFront(cur);

    setLoading(false);
  }

  async function showBack() {
    if (!current) return;
    // Purely optional visual reveal; NO impact on grading progression
    await API.show("back", deck).catch(() => {});
    setMessages((m) => [...m, { role: "assistant", html: current.backHTML || "<i>(No back)</i>" }]);
  }

  // IMPORTANT: Grading advances regardless of whether back was shown.
  async function grade(ease: 1 | 2 | 3 | 4) {
    if (!current) return;
    lastGestureRef.current = Date.now();
    setAllowAutoplay(true);

    // End chat if open
    if (chatMode) {
      const sid = sessionIdRef.current;
      await API.convoReset(sid);
      setChatMode(false);
    }

    await API.answer(ease);

    // Immediately advance — do NOT require a "show back" call
    await API.show("front", deck).catch(() => {});
    const next = await API.current();
    setCurrent(next);
    currentSeqRef.current += 1;

    if (next?.empty || !next?.frontHTML) {
      setMessages((m) => [...m, { role: "assistant", text: "Session finished. No more cards." }]);
      return;
    }

    setMessages((m) => [...m, { role: "assistant", html: next.frontHTML }]);
    await ttsSpeakCardFront(next);
  }

  // ---------- cleanup ----------
  useEffect(() => {
    return () => {
      for (const url of ttsCache.current.values()) {
        try { if (url.startsWith("blob:")) URL.revokeObjectURL(url); } catch {}
      }
      ttsCache.current.clear();
    };
  }, []);

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: "#000" }}>
      <style>{`.card-html, .card-html * { color: #000 !important; }`}</style>

      <h2 style={{ color: "#000" }}>Anki Voice (Back on demand • Grade advances • Markdown chat)</h2>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <select value={deck} onChange={(e) => setDeck(e.target.value)} style={{ minWidth: 280 }}>
          {decks.length === 0 && <option value="">(No decks found)</option>}
          {decks.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>

        <button onClick={handleStart} disabled={loading || !deck}>
          {loading ? "Starting…" : "Start Review"}
        </button>

        <button onClick={() => API.decks().then((r) => r.decks && setDecks(r.decks))}>
          Refresh Decks
        </button>

        {ttsPreview ? <small title={ttsPreview} style={{ color: "#000" }}>TTS preview ready</small> : null}

        <div style={{ marginLeft: 8 }}>
          {recState === "listening" && <small style={{ color: "#000" }}>Listening…</small>}
          {recState === "recording" && <small style={{ color: "#d00", fontWeight: 700 }}>● Recording…</small>}
        </div>
      </div>

      {/* Chat */}
      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} style={{ margin: "8px 0" }}>
            <div
              style={{
                display: "inline-block",
                padding: "8px 10px",
                borderRadius: 8,
                background: m.role === "assistant" ? "#f1f5f9" : "#e8f5e9",
                maxWidth: 760,
                whiteSpace: m.html ? "normal" : "pre-wrap",
                color: "#000",
              }}
            >
              {m.html ? (
                <div className="card-html" style={{ color: "#000" }} dangerouslySetInnerHTML={{ __html: m.html }} />
              ) : (
                <div style={{ color: "#000" }}>
                  <ReactMarkdown>{m.text || ""}</ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Card controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <button onClick={showBack} disabled={!current || !current.backHTML}>Show Back (optional)</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => grade(1)} disabled={!current}>Again</button>
        <button onClick={() => grade(2)} disabled={!current}>Hard</button>
        <button onClick={() => grade(3)} disabled={!current}>Good</button>
        <button onClick={() => grade(4)} disabled={!current}>Easy</button>
      </div>

      {/* Manual Record */}
      <div style={{ marginTop: 10 }}>
        <button
          onClick={async () => {
            if (!current) return;
            const seqAtStart = currentSeqRef.current;
            if (!sttLockRef.current) {
              sttLockRef.current = true;
              try {
                await startListeningForAnswer("german", current, seqAtStart);
              } finally {
                sttLockRef.current = false;
              }
            }
          }}
          disabled={!current}
        >
          🎙️ Record answer
        </button>
        <small style={{ marginLeft: 8, color: "#000" }}>
          (Stops after ~3s of silence. Use the grade buttons to advance.)
        </small>
      </div>

      {/* Free chat */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
        <button
          onClick={async () => {
            setChatMode(true);
            const frontFieldHTML =
              extractFieldHTML(current?.fields || {}, current?.modelName || "", "front") || current?.frontHTML || "";
            const backFieldHTML =
              extractFieldHTML(current?.fields || {}, current?.modelName || "", "back") || current?.backHTML || "";
            const frontTxt = toPlainSpeakable(frontFieldHTML);
            const backTxt  = toPlainSpeakable(backFieldHTML || "");
            const sid = sessionIdRef.current;
            await API.convoStart(sid, undefined, `Card front:\n${frontTxt}\n\nCard back:\n${backTxt}`);
            setMessages(m => [...m, { role: "assistant", text: "Okay, let's discuss this card further." }]);
          }}
          disabled={!current}
        >
          Discuss more
        </button>

        {chatMode && (
          <>
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask a follow-up…"
              style={{ flex: 1, padding: 6, color: "#000" }}
            />
            <button
              onClick={async () => {
                const text = chatInput.trim();
                if (!text) return;
                setChatInput("");
                setMessages(m => [...m, { role: "user", text }]);
                const sid = sessionIdRef.current;
                const r = await API.convoSend(sid, text);
                if (r.ok && r.reply) setMessages(m => [...m, { role: "assistant", text: r.reply }]);
                else setMessages(m => [...m, { role: "assistant", text: r.error || "(conversation failed)" }]);
              }}
            >
              Send
            </button>
            <button
              onClick={async () => {
                setChatMode(false);
                const sid = sessionIdRef.current;
                await API.convoReset(sid);
              }}
            >
              End chat
            </button>
          </>
        )}
      </div>

      {/* Audio */}
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <audio
          ref={audioRef}
          src={ttsUrl || undefined}
          controls
          playsInline
          style={{ width: 360 }}
          onCanPlay={() => {
            if (!audioRef.current) return;
            audioRef.current.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
          }}
        />
        <button
          onClick={() => {
            lastGestureRef.current = Date.now();
            setAllowAutoplay(true);
            if (audioRef.current) {
              audioRef.current.muted = false;
              audioRef.current.currentTime = 0;
              audioRef.current.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
            }
          }}
          disabled={!ttsUrl}
          style={{ display: needsTap ? "inline-block" : "none" }}
        >
          Enable audio
        </button>
        {ttsUrl ? <small style={{ color: "#000" }}>Audio ready</small> : <small style={{ color: "#000" }}>Audio not generated yet</small>}
      </div>
    </div>
  );
}
