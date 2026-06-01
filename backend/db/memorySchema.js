// db/memorySchema.js — Stores every conversation turn + agent memories
import mongoose from "mongoose";

// ── Individual memory entry (a "fact" the agent remembers) ──
const MemoryEntrySchema = new mongoose.Schema({
  userId:    { type: String, required: true, index: true },
  sessionId: { type: String, required: true },           // groups a conversation
  role:      { type: String, enum: ["user", "assistant"], required: true },
  content:   { type: String, required: true },
  metadata:  { type: mongoose.Schema.Types.Mixed, default: {} }, // tags, topic, etc.
  createdAt: { type: Date, default: Date.now },
});

// ── Long-term facts the agent extracts and stores proactively ──
const LongTermMemorySchema = new mongoose.Schema({
  userId:    { type: String, required: true, index: true },
  fact:      { type: String, required: true },           // e.g. "User prefers morning meetings"
  category:  { type: String, default: "general" },       // preference | person | project | deadline
  source:    { type: String },                           // which session this came from
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

export const MemoryEntry    = mongoose.model("MemoryEntry",    MemoryEntrySchema);
export const LongTermMemory = mongoose.model("LongTermMemory", LongTermMemorySchema);
