// routes/agentRoutes.js  ← UPDATED FOR WEEK 2
// New in Week 2: GET /api/agent/briefing — morning intelligence briefing
// All Week 1 routes unchanged.

import express from 'express';
import {
  chat,
  getMemory,
  deleteMemory,
  getHistory,
  getSessions,
} from '../agents/memoryManager.js';
import { generateMorningBriefing, generatePreMeetingBriefing } from '../services/briefingService.js';
import { fetchNextEvent } from '../services/calendarService.js';
import { isGoogleConnected } from '../services/googleAuth.js';

const router = express.Router();

// ─── POST /api/agent/chat (Week 1 — unchanged) ────────────────────────────────
router.post('/chat', async (req, res) => {
  try {
    const { userId, message, sessionId } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required' });
    }

    const result = await chat(userId, message, sessionId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Chat]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agent/memory/:userId (Week 1 — unchanged) ──────────────────────
router.get('/memory/:userId', async (req, res) => {
  try {
    const memories = await getMemory(req.params.userId);
    res.json({ success: true, memories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/agent/memory/:userId/:id (Week 1 — unchanged) ───────────────
router.delete('/memory/:userId/:id', async (req, res) => {
  try {
    const { userId, id } = req.params;
    const deleted = await deleteMemory(userId, id);
    if (!deleted) return res.status(404).json({ error: 'Memory not found' });
    res.json({ success: true, message: 'Memory deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agent/history/:userId/:sessionId (Week 1 — unchanged) ──────────
router.get('/history/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;
    const history = await getHistory(userId, sessionId);
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agent/sessions/:userId (Week 1 — unchanged) ────────────────────
router.get('/sessions/:userId', async (req, res) => {
  try {
    const sessions = await getSessions(req.params.userId);
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  WEEK 2: NEW ENDPOINTS BELOW
// ────────────────────────────────────────────────────────────────────────────

// ─── GET /api/agent/briefing/:userId ─────────────────────────────────────────
// The signature endpoint of Week 2.
// Generates a full morning intelligence briefing combining:
//   - Today's + tomorrow's Google Calendar events
//   - Recent Gmail threads from meeting attendees
//   - Long-term memory facts for personalization
//   - LLaMA 3.3 synthesis into a structured briefing
//
// Usage: GET /api/agent/briefing/user_001
// Called by React dashboard on page load or when user clicks "Brief me"

router.get('/briefing/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Check Google is connected first — briefing requires Calendar + Gmail
    const connected = await isGoogleConnected(userId);
    if (!connected) {
      return res.status(403).json({
        error: 'Google account not connected',
        message: 'Connect your Google account first to enable briefings.',
        connectUrl: `/api/auth/google?userId=${userId}`,
      });
    }

    const briefing = await generateMorningBriefing(userId);
    res.json({ success: true, ...briefing });
  } catch (err) {
    console.error('[Briefing]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agent/briefing/:userId/next-meeting ────────────────────────────
// Focused briefing for the next upcoming meeting only.
// React dashboard can call this proactively (or user asks "brief me for my next meeting").
//
// Usage: GET /api/agent/briefing/user_001/next-meeting

router.get('/briefing/:userId/next-meeting', async (req, res) => {
  try {
    const { userId } = req.params;

    const connected = await isGoogleConnected(userId);
    if (!connected) {
      return res.status(403).json({
        error: 'Google account not connected',
        connectUrl: `/api/auth/google?userId=${userId}`,
      });
    }

    const nextEvent = await fetchNextEvent(userId);
    if (!nextEvent) {
      return res.json({
        success: true,
        message: 'No upcoming meetings found for today.',
        briefing: null,
      });
    }

    const briefing = await generatePreMeetingBriefing(userId, nextEvent);
    res.json({ success: true, ...briefing });
  } catch (err) {
    console.error('[PreMeetingBriefing]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;