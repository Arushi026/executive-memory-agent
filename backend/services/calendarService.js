// services/calendarService.js
// Reads Google Calendar events and formats them for LLM context injection.
// Also extracts attendee emails so gmailService can fetch relevant email threads.

import { google } from 'googleapis';
import { getAuthenticatedClient } from './googleAuth.js';

// ─── Fetch Today's and Tomorrow's Events ─────────────────────────────────────
// Returns events in a clean structured format, ready for LLM injection.

export async function fetchUpcomingEvents(userId, options = {}) {
  const {
    daysAhead = 2,        // How many days to look ahead (default: today + tomorrow)
    maxResults = 20,      // Max events to return
  } = options;

  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  // Time window: from start of today to end of daysAhead days
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endTime = new Date(startOfToday);
  endTime.setDate(endTime.getDate() + daysAhead);

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: startOfToday.toISOString(),
    timeMax: endTime.toISOString(),
    maxResults,
    singleEvents: true,          // Expand recurring events
    orderBy: 'startTime',        // Chronological order
  });

  const events = response.data.items || [];

  if (events.length === 0) {
    return {
      events: [],
      summary: 'No upcoming events found for today or tomorrow.',
      attendeeEmails: [],
    };
  }

  // Parse and structure events
  const parsed = events.map(parseEvent);

  // Extract all unique attendee emails across all events
  // Used by briefingService to fetch relevant email threads
  const attendeeEmails = [
    ...new Set(
      parsed.flatMap(e => e.attendees.map(a => a.email))
        .filter(email => email && !email.includes('calendar.google.com')) // Exclude system emails
    )
  ];

  const summary = formatEventsForLLM(parsed);

  return { events: parsed, summary, attendeeEmails };
}

// ─── Parse a Raw Calendar Event ──────────────────────────────────────────────

function parseEvent(event) {
  // Handle all-day events (date only) vs timed events (dateTime)
  const startRaw = event.start?.dateTime || event.start?.date;
  const endRaw   = event.end?.dateTime   || event.end?.date;

  const isAllDay = !event.start?.dateTime;

  const startDate = new Date(startRaw);
  const endDate   = new Date(endRaw);

  // Format time for display
  const timeOptions = { hour: '2-digit', minute: '2-digit', hour12: true };
  const dateOptions = { weekday: 'short', month: 'short', day: 'numeric' };

  const startFormatted = isAllDay
    ? `All day — ${startDate.toLocaleDateString('en-IN', dateOptions)}`
    : `${startDate.toLocaleDateString('en-IN', dateOptions)} at ${startDate.toLocaleTimeString('en-IN', timeOptions)}`;

  const duration = isAllDay ? 'All day' : getDurationString(startDate, endDate);

  // Extract attendees (exclude the calendar owner's own entry)
  const attendees = (event.attendees || []).map(a => ({
    email: a.email,
    name:  a.displayName || a.email,
    self:  a.self || false,
  }));

  return {
    id:           event.id,
    title:        event.summary || 'Untitled Event',
    startFormatted,
    startRaw:     startDate,
    duration,
    location:     event.location || null,
    description:  event.description
                    ? event.description.replace(/<[^>]+>/g, '').substring(0, 200)
                    : null,
    attendees,
    meetLink:     event.hangoutLink || extractMeetLink(event.description) || null,
    isAllDay,
    status:       event.status,   // confirmed, tentative, cancelled
  };
}

// ─── Get Human-Readable Duration ─────────────────────────────────────────────

function getDurationString(start, end) {
  const mins = Math.round((end - start) / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remaining = mins % 60;
  return remaining > 0 ? `${hours}h ${remaining}min` : `${hours}h`;
}

// ─── Extract Google Meet Link from Description ────────────────────────────────

function extractMeetLink(description) {
  if (!description) return null;
  const match = description.match(/https:\/\/meet\.google\.com\/[a-z-]+/);
  return match ? match[0] : null;
}

// ─── Format Events for LLM Injection ─────────────────────────────────────────
// Creates a structured text block for the agent's system prompt.
// The agent uses this to give proactive schedule awareness.

function formatEventsForLLM(events) {
  if (events.length === 0) return 'No upcoming events.';

  // Group by day for clarity
  const today = new Date();
  const todayStr = today.toDateString();
  const tomorrowStr = new Date(today.getTime() + 86400000).toDateString();

  const todayEvents     = events.filter(e => e.startRaw.toDateString() === todayStr);
  const tomorrowEvents  = events.filter(e => e.startRaw.toDateString() === tomorrowStr);

  let output = 'UPCOMING CALENDAR EVENTS:\n\n';

  if (todayEvents.length > 0) {
    output += `TODAY (${todayEvents.length} events):\n`;
    todayEvents.forEach((e, i) => {
      output += `  ${i + 1}. ${e.title}\n`;
      output += `     When: ${e.startFormatted} (${e.duration})\n`;
      if (e.location)    output += `     Location: ${e.location}\n`;
      if (e.meetLink)    output += `     Meet: ${e.meetLink}\n`;
      if (e.attendees.filter(a => !a.self).length > 0) {
        const names = e.attendees.filter(a => !a.self).map(a => a.name).join(', ');
        output += `     Attendees: ${names}\n`;
      }
      output += '\n';
    });
  }

  if (tomorrowEvents.length > 0) {
    output += `TOMORROW (${tomorrowEvents.length} events):\n`;
    tomorrowEvents.forEach((e, i) => {
      output += `  ${i + 1}. ${e.title}\n`;
      output += `     When: ${e.startFormatted} (${e.duration})\n`;
      if (e.attendees.filter(a => !a.self).length > 0) {
        const names = e.attendees.filter(a => !a.self).map(a => a.name).join(', ');
        output += `     Attendees: ${names}\n`;
      }
      output += '\n';
    });
  }

  return output.trim();
}

// ─── Fetch Next Event (for proactive briefings) ───────────────────────────────
// Returns the next single upcoming event — used by the briefing scheduler
// to trigger pre-meeting briefings 30 minutes before.

export async function fetchNextEvent(userId) {
  const { events } = await fetchUpcomingEvents(userId, { daysAhead: 1, maxResults: 5 });

  const now = new Date();
  const upcoming = events
    .filter(e => !e.isAllDay && e.startRaw > now)
    .sort((a, b) => a.startRaw - b.startRaw);

  return upcoming[0] || null;
}