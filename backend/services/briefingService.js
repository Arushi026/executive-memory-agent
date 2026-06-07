// services/briefingService.js
// Combines Calendar events + Gmail threads + LongTermMemory into
// a proactive morning/pre-meeting briefing using Groq LLaMA.
//
// This is the "killer feature" of Week 2 — the agent proactively knows
// what you have coming up and what context you need, without you asking.

import { ChatGroq } from '@langchain/groq';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { fetchUpcomingEvents } from './calendarService.js';
import { fetchEmailsFromSender } from './gmailService.js';
import { LongTermMemory } from '../agents/memoryManager.js';

// ─── Lazy LLM Init (same pattern as Week 1) ──────────────────────────────────

let llm = null;
function getLLM() {
  if (!llm) {
    llm = new ChatGroq({
      model:       'llama-3.3-70b-versatile',
      apiKey:      process.env.GROQ_API_KEY,
      temperature: 0.4,   // Slightly lower than chat — briefings need precision
      maxTokens:   1500,  // Briefings can be longer than single chat replies
    });
  }
  return llm;
}

// ─── Generate Morning Briefing ────────────────────────────────────────────────
// The full briefing pipeline:
// 1. Fetch today's + tomorrow's events from Google Calendar
// 2. For each event, fetch recent emails from attendees via Gmail
// 3. Load user's long-term memory facts for personalization
// 4. Send everything to LLaMA to synthesize a structured briefing
// 5. Return briefing text + structured data for the React dashboard

export async function generateMorningBriefing(userId) {
  // ── Step 1: Get Calendar Events ──────────────────────────────────────────
  const { events, summary: calendarSummary, attendeeEmails } =
    await fetchUpcomingEvents(userId, { daysAhead: 2 });

  // ── Step 2: Fetch Emails from Meeting Attendees ──────────────────────────
  // Fetch up to 3 emails per attendee — cap at 5 attendees to manage token count
  const relevantAttendees = attendeeEmails.slice(0, 5);

  const emailContextParts = await Promise.allSettled(
    relevantAttendees.map(email =>
      fetchEmailsFromSender(userId, email, 3)
        .then(result => ({ email, summary: result.summary }))
    )
  );

  // Collect successful email fetches only
  const emailContext = emailContextParts
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value.summary)
    .join('\n\n');

  // ── Step 3: Load Long-Term Memory ────────────────────────────────────────
  const memories = await LongTermMemory.find({ userId }).sort({ updatedAt: -1 }).limit(20);
  const memoryContext = memories.length > 0
    ? memories.map(m => `- [${m.category}] ${m.fact}`).join('\n')
    : 'No long-term memory stored yet.';

  // ── Step 4: Build Briefing Prompt ────────────────────────────────────────
  const systemPrompt = `You are an executive AI assistant generating a morning intelligence briefing.
Your job: give the user a clear, actionable briefing about their day.

LONG-TERM MEMORY ABOUT THIS USER:
${memoryContext}

${calendarSummary}

${emailContext ? `RELEVANT EMAIL CONTEXT:\n${emailContext}` : ''}

Generate a structured briefing with these sections:
1. GOOD MORNING — one warm sentence personalizing to their day ahead
2. TODAY'S SCHEDULE — list each event with key context
3. PRE-MEETING INTEL — for each meeting, summarize relevant email threads and past context
4. ACTION ITEMS — anything the user should do or prepare before their first meeting
5. QUICK CONTEXT — any relevant long-term memory facts for today

Keep it concise and actionable. Use plain text, no markdown headers.`;

  const userPrompt = `Generate my morning briefing for today, ${new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  })}.`;

  // ── Step 5: Call Groq LLaMA ───────────────────────────────────────────────
  const response = await getLLM().invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ]);

  const briefingText = response.content;

  // ── Step 6: Return Structured Response ───────────────────────────────────
  return {
    briefing:     briefingText,
    generatedAt:  new Date().toISOString(),
    eventCount:   events.length,
    events:       events.map(e => ({
      title:    e.title,
      time:     e.startFormatted,
      duration: e.duration,
      attendees: e.attendees.filter(a => !a.self).map(a => a.name),
    })),
    emailsScanned: attendeeEmails.length,
  };
}

// ─── Generate Pre-Meeting Briefing ────────────────────────────────────────────
// A focused briefing for ONE specific upcoming meeting.
// Called 30 minutes before a meeting (will be automated in Week 3 scheduler).

export async function generatePreMeetingBriefing(userId, event) {
  // Fetch emails from all non-self attendees
  const attendeeEmails = event.attendees
    .filter(a => !a.self)
    .map(a => a.email);

  const emailParts = await Promise.allSettled(
    attendeeEmails.map(email => fetchEmailsFromSender(userId, email, 5))
  );

  const emailContext = emailParts
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value.summary)
    .join('\n\n');

  // Load relevant long-term memories
  const memories = await LongTermMemory.find({ userId }).limit(15);
  const memoryContext = memories.map(m => `- [${m.category}] ${m.fact}`).join('\n');

  const systemPrompt = `You are an executive AI assistant preparing a pre-meeting briefing.
Focus only on what is relevant for this specific meeting.

USER'S LONG-TERM MEMORY:
${memoryContext || 'None stored yet.'}

${emailContext ? `RECENT EMAIL THREADS WITH ATTENDEES:\n${emailContext}` : 'No recent emails found with attendees.'}

Generate a focused pre-meeting briefing covering:
1. MEETING CONTEXT — who is attending and why this meeting matters
2. EMAIL THREAD SUMMARY — key points from recent emails with these attendees
3. WHAT TO PREPARE — specific things to have ready or decide before the call
4. PAST CONTEXT — anything from long-term memory relevant to this meeting

Be specific and brief — the user has ${getMinutesUntil(event.startRaw)} minutes before this starts.`;

  const userPrompt = `Prepare me for my ${event.title} meeting starting at ${event.startFormatted}.`;

  const response = await getLLM().invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ]);

  return {
    briefing:    response.content,
    eventTitle:  event.title,
    eventTime:   event.startFormatted,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Helper: Minutes Until Event ─────────────────────────────────────────────

function getMinutesUntil(eventDate) {
  return Math.max(0, Math.round((new Date(eventDate) - Date.now()) / 60000));
}