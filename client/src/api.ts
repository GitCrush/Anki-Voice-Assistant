// client/src/api.ts
export type CurrentCard = {
  ok?: boolean;
  empty?: boolean;
  reason?: string;
  error?: string;
  cardId?: number;
  frontHTML?: string;
  backHTML?: string;
  modelName?: string;
  templateName?: string;
  fields?: Record<string, { value: string; order: number }>;
};

export async function health() {
  const r = await fetch("/api/health");
  return r.json();
}

export async function decks(): Promise<{ok:boolean; decks?: string[]; error?: string}> {
  const r = await fetch("/api/decks");
  return r.json();
}

export async function start(deckName: string) {
  const r = await fetch("/api/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deckName }),
  });
  return r.json();
}

export async function current(): Promise<CurrentCard> {
  const r = await fetch("/api/current");
  return r.json();
}

export async function show(side: "front"|"back", deckName?: string) {
  const r = await fetch("/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ side, deckName }),
  });
  return r.json();
}

export async function answer(ease: 1|2|3|4) {
  const r = await fetch("/api/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ease }),
  });
  return r.json();
}

export async function tts(text: string): Promise<string | null> {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const json = await r.json();
  return json.ok ? (json.url as string) : null;
}

// ---- Prefetch helpers ----
export async function candidates(deckName: string, limit = 10): Promise<{ok:boolean; cardIds?: number[]; error?: string}> {
  const r = await fetch(`/api/candidates?deckName=${encodeURIComponent(deckName)}&limit=${limit}`);
  return r.json();
}

export async function cardsInfo(ids: number[]): Promise<any[]> {
  const r = await fetch("/api/cardsInfo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cards: ids }),
  });
  return r.json();
}

export async function stt(audioBase64: string, language?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const r = await fetch("/api/stt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioBase64, language }),
  });
  return r.json();
}

export async function reviewChain(payload: {
  audioBase64: string;
  front: string;
  back?: string;
  language?: string;
}) {
  const r = await fetch("/api/review-chain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}


export async function convoStart(sessionId: string, system?: string, seedContext?: string) {
  const r = await fetch("/api/conversation/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, system, seedContext }),
  });
  return r.json();
}

export async function convoSend(sessionId: string, user: string) {
  const r = await fetch("/api/conversation/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, user }),
  });
  return r.json();
}

export async function convoReset(sessionId: string) {
  const r = await fetch("/api/conversation/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  return r.json();
}

