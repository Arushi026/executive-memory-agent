// agents/memoryManager.js
// ─────────────────────────────────────────────────────────────────────────────
// This is the BRAIN of the project. It handles:
//  1. Saving each conversation turn to MongoDB
//  2. Loading recent history for context
//  3. Extracting + storing long-term facts via LLM
// ─────────────────────────────────────────────────────────────────────────────

import { ChatGroq } from "@langchain/groq";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { MemoryEntry, LongTermMemory } from "../db/memorySchema.js";
import { v4 as uuidv4 } from "uuid";

// ── getLLM() instead of top-level init — reads env AFTER dotenv.config() runs ──
const getLLM = () => new ChatGroq({
  apiKey: process.env.GROQ_API_KEY,
  model: "llama-3.3-70b-versatile",
  temperature: 0.7,
});

export const saveMessage = async (userId, sessionId, role, content, metadata = {}) => {
  const entry = new MemoryEntry({ userId, sessionId, role, content, metadata });
  await entry.save();
  return entry;
};

export const loadSessionHistory = async (userId, sessionId, limit = 10) => {
  const messages = await MemoryEntry.find({ userId, sessionId })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  return messages.map((m) =>
    m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)
  );
};

export const loadLongTermMemory = async (userId) => {
  const facts = await LongTermMemory.find({ userId })
    .sort({ updatedAt: -1 })
    .limit(20)
    .lean();

  if (facts.length === 0) return "";
  return "LONG-TERM MEMORY ABOUT THIS USER:\n" +
    facts.map((f) => `- [${f.category}] ${f.fact}`).join("\n");
};

export const extractAndStoreFacts = async (userId, sessionId, conversation) => {
  const llm = getLLM();
  const prompt = `
You are a memory extraction system. Extract factual things worth remembering long-term about the USER ONLY.
Categories: preference | person | project | deadline | habit
Return a JSON array like: [{ "fact": "...", "category": "..." }]
If nothing worth remembering, return: []
Conversation:
${conversation}
Return ONLY the JSON array, no other text.`.trim();

  try {
    const response = await llm.invoke([new HumanMessage(prompt)]);
    const raw = response.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;
    const facts = JSON.parse(jsonMatch[0]);
    for (const { fact, category } of facts) {
      await LongTermMemory.findOneAndUpdate(
        { userId, fact },
        { userId, fact, category, source: sessionId, updatedAt: new Date() },
        { upsert: true, new: true }
      );
    }
    console.log(`🧠 Stored ${facts.length} long-term facts for user ${userId}`);
  } catch (err) {
    console.error("⚠️  Fact extraction failed:", err.message);
  }
};

export const chat = async (userId, userMessage, sessionId = null) => {
  const llm = getLLM();
  const activeSession = sessionId || uuidv4();

  await saveMessage(userId, activeSession, "user", userMessage);

  const history       = await loadSessionHistory(userId, activeSession);
  const longTermFacts = await loadLongTermMemory(userId);

  const systemPrompt = `You are an Executive Memory Agent — a highly intelligent personal assistant with persistent memory.
${longTermFacts}
Reference past context naturally when relevant. Be concise and proactive.`.trim();

  const messages = [
    new SystemMessage(systemPrompt),
    ...history,
    new HumanMessage(userMessage),
  ];

  const response = await llm.invoke(messages);
  const assistantReply = response.content;

  await saveMessage(userId, activeSession, "assistant", assistantReply);

  const turnCount = await MemoryEntry.countDocuments({ userId, sessionId: activeSession, role: "user" });
  if (turnCount % 3 === 0) {
    const allTurns = await MemoryEntry.find({ userId, sessionId: activeSession }).sort({ createdAt: 1 }).lean();
    const convoText = allTurns.map((m) => `${m.role}: ${m.content}`).join("\n");
    extractAndStoreFacts(userId, activeSession, convoText);
  }

  return { reply: assistantReply, sessionId: activeSession };
};
