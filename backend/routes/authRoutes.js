// routes/authRoutes.js
// Two endpoints that handle the Google OAuth 2.0 flow:
//   GET  /api/auth/google          → redirects user to Google consent page
//   GET  /api/auth/google/callback → handles the return, exchanges code for tokens

import express from 'express';
import { generateAuthUrl, exchangeCodeForTokens, isGoogleConnected } from '../services/googleAuth.js';

const router = express.Router();

// ─── GET /api/auth/google ─────────────────────────────────────────────────────
// Called from the React frontend when user clicks "Connect Google Account".
// In Week 1 we had no auth — userId is passed as query param for now.
// Week 4 will replace this with proper JWT auth.
//
// Usage: GET /api/auth/google?userId=user_001

router.get('/google', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId query parameter is required' });
  }

  const authUrl = generateAuthUrl(userId);

  // Redirect user to Google's consent page
  res.redirect(authUrl);
});

// ─── GET /api/auth/google/callback ───────────────────────────────────────────
// Google redirects here after user grants/denies access.
// URL includes: ?code=AUTH_CODE&state=USER_ID (or ?error=access_denied)
//
// The `state` parameter is the userId we passed in generateAuthUrl.

router.get('/google/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;

  // User denied access
  if (error) {
    console.error('[OAuth] User denied access:', error);
    return res.redirect(`${process.env.FRONTEND_URL}?google_auth=denied`);
  }

  if (!code || !userId) {
    return res.status(400).json({ error: 'Missing code or userId from Google callback' });
  }

  try {
    await exchangeCodeForTokens(code, userId);
    console.log(`[OAuth] Google connected successfully for user: ${userId}`);

    // Redirect back to React app with success flag
    // The frontend checks ?google_auth=success and shows a success toast
    res.redirect(`${process.env.FRONTEND_URL}?google_auth=success&userId=${userId}`);
  } catch (err) {
    console.error('[OAuth] Token exchange failed:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}?google_auth=error`);
  }
});

// ─── GET /api/auth/status/:userId ────────────────────────────────────────────
// React frontend calls this on load to show "Connected" / "Connect Google" button.

router.get('/status/:userId', async (req, res) => {
  try {
    const connected = await isGoogleConnected(req.params.userId);
    res.json({ userId: req.params.userId, googleConnected: connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;