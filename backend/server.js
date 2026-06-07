// server.js  ← UPDATED FOR WEEK 2
// Changes from Week 1:
//   - Added authRoutes mounted at /api/auth
//   - Added FRONTEND_URL to .env requirements list
//   - Everything else identical to Week 1

import 'dotenv/config';          // MUST be first — loads .env before any imports
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

import agentRoutes from './routes/agentRoutes.js';
import authRoutes  from './routes/authRoutes.js';  // ← NEW Week 2

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/agent', agentRoutes);   // Week 1 routes + new briefing endpoints
app.use('/api/auth',  authRoutes);    // ← NEW Week 2: Google OAuth flow

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    week: 2,
    timestamp: new Date().toISOString(),
  });
});

// ─── MongoDB Connection ───────────────────────────────────────────────────────

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`   Week 2 endpoints:`);
      console.log(`   GET  /api/auth/google              → Connect Google`);
      console.log(`   GET  /api/auth/google/callback     → OAuth callback`);
      console.log(`   GET  /api/auth/status/:userId      → Check connection`);
      console.log(`   GET  /api/agent/briefing/:userId   → Morning briefing`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });