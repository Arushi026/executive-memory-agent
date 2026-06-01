// routes/agentRoutes.js — REST API for the agent (your comfort zone: Express!)
import express from "express";
import { chat }            from "../agents/memoryManager.js";
import { MemoryEntry, LongTermMemory } from "../db/memorySchema.js";

const router = express.Router();

// ── POST /api/agent/chat ─────────────────────────────────────────────────────
// Main chat endpoint. Frontend sends message, gets reply + sessionId back.
router.post("/chat", async (req, res) => {
  const { userId, message, sessionId } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: "userId and message are required" });
  }

  try {
    const result = await chat(userId, message, sessionId);
    res.json({
      success: true,
      reply:     result.reply,
      sessionId: result.sessionId,
    });
  } catch (err) {
    console.error("Agent error:", err);
    res.status(500).json({ error: "Agent failed", details: err.message });
  }
});

// ── GET /api/agent/history/:userId/:sessionId ────────────────────────────────
router.get("/history/:userId/:sessionId", async (req, res) => {
  const { userId, sessionId } = req.params;
  try {
    const messages = await MemoryEntry.find({ userId, sessionId })
      .sort({ createdAt: 1 })
      .lean();
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/agent/memory/:userId ────────────────────────────────────────────
// Returns all long-term facts the agent knows about this user
router.get("/memory/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const facts = await LongTermMemory.find({ userId })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ success: true, facts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/agent/memory/:userId/:factId ─────────────────────────────────
router.delete("/memory/:userId/:factId", async (req, res) => {
  const { userId, factId } = req.params;
  try {
    await LongTermMemory.findOneAndDelete({ _id: factId, userId });
    res.json({ success: true, message: "Memory deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/agent/sessions/:userId ──────────────────────────────────────────
router.get("/sessions/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const sessions = await MemoryEntry.aggregate([
      { $match: { userId, role: "user" } },
      { $sort:  { createdAt: -1 } },
      { $group: {
          _id:       "$sessionId",
          firstMsg:  { $last:  "$content" },
          lastActive:{ $first: "$createdAt" },
          turnCount: { $sum: 1 },
      }},
      { $limit: 20 },
    ]);
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
