// services/gmailService.js
// Reads recent emails for a user and formats them for LLM context injection.
// Uses gmail.readonly scope — cannot send or delete emails.

import { google } from 'googleapis';
import { getAuthenticatedClient } from './googleAuth.js';

// ─── Fetch Recent Emails ──────────────────────────────────────────────────────
// Returns the last `maxResults` emails, cleaned and formatted for LLM context.
// Optionally filter by sender email to get thread-specific context before a meeting.

export async function fetchRecentEmails(userId, options = {}) {
  const {
    maxResults = 10,
    senderEmail = null,   // e.g. "priya@company.com" — filters by sender
    subject = null,       // e.g. "API deployment" — filters by subject keyword
  } = options;

  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  // Build query string — same syntax as Gmail search bar
  let query = '';
  if (senderEmail) query += `from:${senderEmail} `;
  if (subject)     query += `subject:${subject} `;
  // Default: just get recent inbox emails if no filter
  if (!query) query = 'in:inbox';

  // Step 1: List matching message IDs
  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query.trim(),
    maxResults,
  });

  const messages = listResponse.data.messages || [];

  if (messages.length === 0) {
    return { emails: [], summary: 'No recent emails found matching your criteria.' };
  }

  // Step 2: Fetch full message details for each ID
  const emailDetails = await Promise.all(
    messages.map(msg => gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    }))
  );

  // Step 3: Parse and clean each email
  const emails = emailDetails.map(res => parseEmail(res.data));

  // Step 4: Format as structured text for LLM injection
  const summary = formatEmailsForLLM(emails);

  return { emails, summary };
}

// ─── Parse Raw Gmail Message ──────────────────────────────────────────────────
// Extracts sender, subject, date, and body text from the Gmail API response.
// Handles base64 encoded body and multipart messages.

function parseEmail(message) {
  const headers = message.payload?.headers || [];

  const getHeader = (name) =>
    headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const from    = getHeader('From');
  const subject = getHeader('Subject');
  const date    = getHeader('Date');

  // Extract body text — handle both simple and multipart messages
  let body = extractBody(message.payload);

  // Clean up the body — remove excessive whitespace, quoted replies, signatures
  body = cleanEmailBody(body);

  return {
    id: message.id,
    from,
    subject,
    date: new Date(date).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }),
    body: body.substring(0, 500), // Cap at 500 chars per email to manage token count
    snippet: message.snippet || '',
  };
}

// ─── Extract Body from Payload ────────────────────────────────────────────────
// Gmail stores body in base64. Handles simple messages and multipart/alternative.

function extractBody(payload) {
  if (!payload) return '';

  // Simple message — body directly in payload
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart message — find the text/plain part first, fallback to text/html
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');

    const part = textPart || htmlPart;
    if (part?.body?.data) {
      const decoded = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      // Strip HTML tags if we fell back to html part
      return htmlPart && !textPart
        ? decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : decoded;
    }

    // Nested multipart — recurse into first part
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }

  return '';
}

// ─── Clean Email Body ─────────────────────────────────────────────────────────
// Removes quoted replies (lines starting with >), email signatures, and extra whitespace.

function cleanEmailBody(body) {
  return body
    .split('\n')
    .filter(line => !line.startsWith('>'))          // Remove quoted replies
    .filter(line => !line.startsWith('--'))         // Remove signature separator
    .join('\n')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')                     // Max 2 consecutive blank lines
    .trim();
}

// ─── Format Emails for LLM Injection ─────────────────────────────────────────
// Creates a clean, structured text block injected into the agent's system prompt.

function formatEmailsForLLM(emails) {
  if (emails.length === 0) return 'No recent emails.';

  const formatted = emails.map((email, i) =>
    `Email ${i + 1}:
  From: ${email.from}
  Subject: ${email.subject}
  Date: ${email.date}
  Content: ${email.body || email.snippet}`
  ).join('\n\n---\n\n');

  return `RECENT EMAILS (${emails.length} messages):\n\n${formatted}`;
}

// ─── Fetch Emails from Specific Sender (for Meeting Prep) ────────────────────
// Convenience function — called when agent prepares a pre-meeting briefing.
// Finds the last few emails from attendees of an upcoming meeting.

export async function fetchEmailsFromSender(userId, senderEmail, maxResults = 5) {
  return fetchRecentEmails(userId, { senderEmail, maxResults });
}