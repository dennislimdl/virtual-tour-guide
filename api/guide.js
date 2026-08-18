import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

const GUIDE_PERSONA = `You are Ava, a warm, knowledgeable local tour guide speaking out loud to a visitor standing right beside you. You are not reading an article — you're having a real, in-person conversation, the way an experienced local guide would.

Style rules:
- Speak in natural, spoken sentences with contractions and warmth. No markdown, no bullet points, no headers, no citations, no emoji.
- When introducing a new place: 3-6 sentences. Pick the one or two most interesting or surprising things about it instead of listing every fact. End in a way that invites a follow-up question.
- When answering a question: answer directly and conversationally in a few sentences, then stop — don't lecture.
- If you're not confident about a specific fact, say so honestly or keep it general instead of inventing details.
- Never say "according to Wikipedia" or mention your sources — just speak as a guide who knows the place.`;

let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res
      .status(503)
      .json({ error: "AI guide is not configured (missing ANTHROPIC_API_KEY)." });
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

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: GUIDE_PERSONA,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: userText }],
  });
  return extractText(resp);
}

async function chat(landmark, history, question) {
  // The API requires the first message to have role "user". Our history can
  // start with an assistant-only narration turn (a question asked right after
  // the guide's intro, before any user turn exists) — skip leading assistant
  // turns, but keep the last one as a short context note so we don't lose it.
  const messages = [];
  let recentAssistantNote = "";
  let sawUserTurn = false;
  for (const turn of history.slice(-12)) {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant")) continue;
    if (!sawUserTurn && turn.role === "assistant") {
      recentAssistantNote = String(turn.content || "").slice(0, 500);
      continue;
    }
    sawUserTurn = true;
    messages.push({
      role: turn.role,
      content: String(turn.content || "").slice(0, 2000),
    });
  }

  const contextParts = [];
  if (landmark?.title) {
    contextParts.push(`The visitor is currently standing at "${landmark.title}".`);
  }
  if (recentAssistantNote) {
    contextParts.push(`You just told them: "${recentAssistantNote}"`);
  }
  const context = contextParts.length ? `(${contextParts.join(" ")}) ` : "";
  messages.push({ role: "user", content: `${context}${question}`.slice(0, 2000) });

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: GUIDE_PERSONA,
    output_config: { effort: "low" },
    messages,
  });
  return extractText(resp);
}

function extractText(resp) {
  const block = resp.content?.find((b) => b.type === "text");
  const text = block?.text?.trim();
  if (!text) throw new Error("Empty response from model.");
  return text;
}
