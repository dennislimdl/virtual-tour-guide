import { GoogleGenAI, ApiError } from "@google/genai";

// Gemini has a free tier via Google AI Studio (no billing required).
// Override with GEMINI_MODEL if you want a different free-tier model, e.g.
// "gemini-flash-lite-latest" for a higher daily request quota.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const GUIDE_PERSONA = `You are Ava, a warm, knowledgeable local tour guide speaking out loud to a visitor standing right beside you. You are not reading an article — you're having a real, in-person conversation, the way an experienced local guide would.

Style rules:
- Speak in natural, spoken sentences with contractions and warmth. No markdown, no bullet points, no headers, no citations, no emoji.
- When introducing a new place: 3-6 sentences. Pick the one or two most interesting or surprising things about it instead of listing every fact. End in a way that invites a follow-up question.
- When answering a question: answer directly and conversationally in a few sentences, then stop — don't lecture.
- If you're not confident about a specific fact, say so honestly or keep it general instead of inventing details.
- Never say "according to Wikipedia" or mention your sources — just speak as a guide who knows the place.`;

let client;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res
      .status(503)
      .json({ error: "AI guide is not configured (missing GEMINI_API_KEY)." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const { mode, landmark, history, question } = body || {};

  try {
    let text;
    if (mode === "narrate") {
      if (!landmark?.title) {
        res.status(400).json({ error: "Missing landmark." });
        return;
      }
      text = await narrate(landmark);
    } else if (mode === "chat") {
      if (!question || typeof question !== "string") {
        res.status(400).json({ error: "Missing question." });
        return;
      }
      text = await chat(landmark, Array.isArray(history) ? history : [], question);
    } else {
      res.status(400).json({ error: "Unknown mode." });
      return;
    }
    res.status(200).json({ text });
  } catch (err) {
    console.error("guide api error", err);
    if (err instanceof ApiError && err.status === 429) {
      res.status(429).json({
        error:
          "The AI guide hit its free-tier rate limit. Please wait a moment and try again.",
      });
      return;
    }
    res
      .status(502)
      .json({ error: "The AI guide had trouble responding. Please try again." });
  }
}

async function narrate(landmark) {
  const grounding = String(landmark.extract || "").slice(0, 1600);
  const referenceBlock = grounding
    ? grounding
    : "(no reference material available — speak from general knowledge, and if you're not confident about specifics, keep it general rather than inventing facts.)";
  const userText = `We just arrived at "${landmark.title}". Here is some reference material for grounding only — do not read it verbatim, do not quote it directly, and do not mention "Wikipedia" or "according to":\n\n${referenceBlock}\n\nGive your spoken introduction to this place now.`;

  const resp = await getClient().models.generateContent({
    model: MODEL,
    contents: userText,
    config: {
      systemInstruction: GUIDE_PERSONA,
      maxOutputTokens: 400,
      temperature: 0.9,
      // This model spends part of maxOutputTokens on hidden "thinking"
      // tokens by default, which was truncating short spoken replies
      // mid-sentence. A quick conversational reply doesn't need extended
      // reasoning, so keep thinking minimal.
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    },
  });
  return extractText(resp);
}

async function chat(landmark, history, question) {
  // Keep the transcript grounded even if the history starts with a
  // guide-only narration turn (no prior user turn) — fold it into a short
  // context note instead of sending it as a leading "model" turn.
  const contents = [];
  let recentModelNote = "";
  let sawUserTurn = false;
  for (const turn of history.slice(-12)) {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant")) continue;
    const geminiRole = turn.role === "assistant" ? "model" : "user";
    if (!sawUserTurn && geminiRole === "model") {
      recentModelNote = String(turn.content || "").slice(0, 500);
      continue;
    }
    sawUserTurn = true;
    contents.push({
      role: geminiRole,
      parts: [{ text: String(turn.content || "").slice(0, 2000) }],
    });
  }

  const contextParts = [];
  if (landmark?.title) {
    contextParts.push(`The visitor is currently standing at "${landmark.title}".`);
  }
  if (recentModelNote) {
    contextParts.push(`You just told them: "${recentModelNote}"`);
  }
  const context = contextParts.length ? `(${contextParts.join(" ")}) ` : "";
  contents.push({
    role: "user",
    parts: [{ text: `${context}${question}`.slice(0, 2000) }],
  });

  const resp = await getClient().models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: GUIDE_PERSONA,
      maxOutputTokens: 400,
      temperature: 0.9,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    },
  });
  return extractText(resp);
}

function extractText(resp) {
  const text = resp?.text?.trim();
  if (!text) throw new Error("Empty response from model.");
  return text;
}
