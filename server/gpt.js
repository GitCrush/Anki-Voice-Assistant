// server/gpt.js
import Replicate from "replicate";
import dotenv from "dotenv";

dotenv.config();

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const DEFAULT_MODEL = "openai/gpt-4.1";


// ----- One-shot review -----
export async function reviewChat({ front, back, transcript, extras }) {
  const sys = extras?.system ||
`You are a helpful anki card review assistant.
- Compare the learner's spoken answer to the card's front/back and the expected reply from the cards back.
- Be concise. Then judge the correctness of the students answer.
- Then give a short explanation and the correct answer if needed.
- If it's a cloze, reveal the cloze succinctly and always show the full original back part `;

  const user = `Card front:\n${front}\n\nCard back:\n${back || "(none)"}\n\nLearner said:\n${transcript}`;

  const input = {
    top_p: 1,
    temperature: 0.2,
    presence_penalty: 0,
    frequency_penalty: 0,
    max_completion_tokens: 1024,
    system_prompt: sys,
    messages: [
      { role: "user", content: user }
    ]
  };

  let outputText = "";
  for await (const event of replicate.stream(DEFAULT_MODEL, { input })) {
    outputText += event.toString();
  }
  return outputText.trim();
}

// ----- Conversation manager (in-memory) -----
const sessions = new Map(); // sessionId -> { messages: [...] }

export function startConversation({ sessionId, system, seedContext }) {
  const msg = [
    { role: "system", content: system || "You are a friendly tutor. Stay concise, encourage active recall." }
  ];
  if (seedContext) {
    msg.push({ role: "user", content: `Context:\n${seedContext}` });
    msg.push({ role: "assistant", content: "Got it. What would you like to discuss?" });
  }
  sessions.set(sessionId, { messages: msg });
  return { ok: true };
}

export function resetConversation({ sessionId }) {
  sessions.delete(sessionId);
  return { ok: true };
}

export async function sendConversation({ sessionId, user }) {
  const sess = sessions.get(sessionId);
  if (!sess) throw new Error("No conversation session; call /conversation/start first.");
  sess.messages.push({ role: "user", content: user });

  const input = {
    top_p: 1,
    temperature: 0.5,
    presence_penalty: 0,
    frequency_penalty: 0,
    max_completion_tokens: 1024,
    system_prompt: sess.messages.find(m => m.role === "system")?.content || "",
    messages: sess.messages.filter(m => m.role !== "system")
  };

  let reply = "";
  for await (const event of replicate.stream(DEFAULT_MODEL, { input })) {
    reply += event.toString();
  }

  sess.messages.push({ role: "assistant", content: reply });
  return { reply };
}
