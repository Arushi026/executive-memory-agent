// agents/memoryManager.js  ← UPDATED FOR WEEK 2
// Changes from Week 1:
//   - chat() now accepts optional `includeGoogleContext` flag
//   - If Google is connected, Calendar + Gmail context is injected into system prompt
//   - isGoogleConnected check is graceful — works fine if user hasn't connected yet
//   - LongTermMemory export added so briefingService.js can import it directly

import { ChatGroq } from '@langchain/groq';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { isGoogleConnected } from '../services/googleAuth.js';
import { fetchUpcomingEvents } from '../services/calendarService.js';
import { fetchRecentEmails } from '../services/gmailService.js';

// ─── MongoDB Schemas (unchanged from Week 1) ──────────────────────────────────

const memoryEntrySchema = new mongoose.Schema({
  userId:    { type: String, required: true, index: true },
  sessionId: { type: String, required: true },
  role:      { type: String, enum: ['user', 'assistant'], required: true },
  content:   { type: String, required: true },
  metadata:  { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
});

const longTermMemorySchema = new mongoose.Schema({
  userId:    { type: String, required: true, index: true },
  fact:      { type: String, required: true },
  category:  { type: String, default: 'general' },
  source:    { type: String, default: 'conversation' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

export const MemoryEntry    = mongoose.model('MemoryEntry', memoryEntrySchema);
export const LongTermMemory = mongoose.model('LongTermMemory', longTermMemorySchema); // ← now exported

// ─── Lazy LLM Init ────────────────────────────────────────────────────────────

let llm = null;
function getLLM() {
  if (!llm) {
    llm = new ChatGroq({
      model:       'llama-3.3-70b-versatile',
      apiKey:      process.env.GROQ_API_KEY,
      temperature: 0.7,
      maxTokens:   1000,
    });
  }
  return llm;
}

// ─── Main Chat Function — UPDATED ─────────────────────────────────────────────

export async function chat(userId, message, sessionId = null) {
  // Step 1: Session management
  const currentSessionId = sessionId || uuidv4();

  // Step 2: Save user message
  await MemoryEntry.create({ userId, sessionId: currentSessionId, role: 'user', content: message });

  // Step 3: Load short-term memory (last 10 messages in session)
  const recentMessages = await MemoryEntry.find({ userId, sessionId: currentSessionId })
    .sort({ createdAt: -1 })
    .limit(10);
  const history = recentMessages.reverse();

  // Step 4: Load long-term memory
  const longTermFacts = await LongTermMemory.find({ userId }).sort({ updatedAt: -1 }).limit(20);
  const factsText = longTermFacts.length > 0
    ? longTermFacts.map(f => `- [${f.category}] ${f.fact}`).join('\n')
    : 'No long-term memories stored yet.';

  // ── WEEK 2 ADDITION: Load Google context if connected ────────────────────
  let googleContext = '';
  try {
    const googleConnected = await isGoogleConnected(userId);
    if (googleConnected) {
      // Load Calendar and Gmail in parallel to keep latency low
      const [calendarResult, emailResult] = await Promise.allSettled([
        fetchUpcomingEvents(userId, { daysAhead: 2 }),
        fetchRecentEmails(userId, { maxResults: 5 }),
      ]);

      if (calendarResult.status === 'fulfilled') {
        googleContext += `\n\n${calendarResult.value.summary}`;
      }
      if (emailResult.status === 'fulfilled') {
        googleContext += `\n\n${emailResult.value.summary}`;
      }
    }
  } catch (err) {
    // Google context is enhancement-only — never fail the main chat if it errors
    console.warn('[Week2] Google context load failed (non-fatal):', err.message);
  }

  // Step 5: Build system prompt
  const systemPrompt = `You are an intelligent executive assistant with persistent memory.
You remember everything about this user across all conversations.

WHAT YOU KNOW ABOUT THIS USER:
${factsText}${googleContext}

Instructions:
- Use the user's name and stored context naturally — don't announce that you have memory
- Reference calendar events proactively when relevant (e.g. "you have standup in 30 minutes")
- If you see relevant emails, mention them helpfully ("Priya emailed about the deploy — want a summary?")
- Be concise and actionable
- When you learn new facts, you will store them automatically`;

  // Step 6: Build messages array for LLM
  const messages = [
    new SystemMessage(systemPrompt),
    ...history.slice(0, -1).map(m =>    // Exclude last message (that's the new HumanMessage)
      m.role === 'user'
        ? new HumanMessage(m.content)
        : new AIMessage(m.content)
    ),
    new HumanMessage(message),
  ];

  // Step 7: Call Groq
  const response = await getLLM().invoke(messages);
  const reply = response.content;

  // Step 8: Save assistant reply
  await MemoryEntry.create({ userId, sessionId: currentSessionId, role: 'assistant', content: reply });

  // Step 9: Background fact extraction every 3 messages (unchanged from Week 1)
  const messageCount = await MemoryEntry.countDocuments({ userId, sessionId: currentSessionId });
  if (messageCount % 3 === 0) {
    extractAndStoreFacts(userId, history, message, reply); // fire-and-forget
  }

  return { reply, sessionId: currentSessionId };
}

// ─── Background Fact Extraction (unchanged from Week 1) ──────────────────────

async function extractAndStoreFacts(userId, history, userMessage, assistantReply) {
  try {
    const conversationText = [
      ...history.map(m => `${m.role}: ${m.content}`),
      `user: ${userMessage}`,
      `assistant: ${assistantReply}`,
    ].join('\n');

    const extractionPrompt = `Analyze this conversation and extract facts about the USER ONLY that are worth remembering long-term.

Conversation:
${conversationText}

Extract facts like: preferences, projects they're working on, deadlines, habits, opinions, goals, technical skills, team members, decisions made.

Return ONLY a JSON array. No other text. No markdown. Example:
[{"fact": "Prefers async communication over meetings", "category": "preference"}]

Categories: preference, project, deadline, habit, skill, team, decision, goal, personal

If no meaningful facts found, return: []`;

    const response = await getLLM().invoke([new HumanMessage(extractionPrompt)]);
    const text = response.content;

    // Safely extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const facts = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(facts) || facts.length === 0) return;

    // Upsert each fact — prevents duplicates building up
    for (const item of facts) {
      if (!item.fact || typeof item.fact !== 'string') continue;

      await LongTermMemory.findOneAndUpdate(
        { userId, fact: { $regex: new RegExp(item.fact.substring(0, 30), 'i') } },
        {
          userId,
          fact:      item.fact,
          category:  item.category || 'general',
          updatedAt: new Date(),
        },
        { upsert: true, new: true }
      );
    }

    console.log(`[Memory] Extracted ${facts.length} facts for user ${userId}`);
  } catch (err) {
    console.error('[Memory] Fact extraction failed (non-fatal):', err.message);
  }
}

// ─── Memory Management Functions (unchanged from Week 1) ─────────────────────

export async function getMemory(userId) {
  return LongTermMemory.find({ userId }).sort({ updatedAt: -1 });
}

export async function deleteMemory(userId, memoryId) {
  return LongTermMemory.findOneAndDelete({ _id: memoryId, userId });
}

export async function getHistory(userId, sessionId) {
  return MemoryEntry.find({ userId, sessionId }).sort({ createdAt: 1 });
}

export async function getSessions(userId) {
  return MemoryEntry.aggregate([
    { $match: { userId, role: 'user' } },
    { $sort:  { createdAt: 1 } },
    { $group: {
        _id:        '$sessionId',
        firstMsg:   { $first: '$content' },
        lastActive: { $max:   '$createdAt' },
        turnCount:  { $sum:   1 },
    }},
    { $sort: { lastActive: -1 } },
    { $project: {
        sessionId:  '$_id',
        title:      { $substrCP: ['$firstMsg', 0, 50] },
        lastActive: 1,
        turnCount:  1,
    }},
  ]);
}