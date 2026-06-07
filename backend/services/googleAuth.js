// services/googleAuth.js
// Handles Google OAuth 2.0 — token exchange, refresh, and storage in MongoDB

import { google } from 'googleapis';
import mongoose from 'mongoose';

// ─── OAuth Token Schema ───────────────────────────────────────────────────────
// Stores refresh tokens per user. Access tokens are short-lived (1hr) and
// generated on-demand from the stored refresh token — user never logs in again.

const googleTokenSchema = new mongoose.Schema({
  userId:       { type: String, required: true, unique: true, index: true },
  accessToken:  { type: String },          // Short-lived, regenerated automatically
  refreshToken: { type: String, required: true }, // Long-lived, stored permanently
  expiryDate:   { type: Number },          // Unix ms timestamp when access token expires
  scope:        { type: String },          // Scopes user granted
  createdAt:    { type: Date, default: Date.now },
  updatedAt:    { type: Date, default: Date.now },
});

export const GoogleToken = mongoose.model('GoogleToken', googleTokenSchema);

// ─── OAuth Client Factory ─────────────────────────────────────────────────────
// Called lazily (not at module level) — dotenv must have loaded GOOGLE_* keys first.

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI   // e.g. http://localhost:5000/api/auth/google/callback
  );
}

// ─── Step 1: Generate Consent URL ────────────────────────────────────────────
// User is redirected here to grant Gmail + Calendar read access.
// We request offline access to get a refresh token.

export function generateAuthUrl(userId) {
  const oauth2Client = getOAuthClient();

  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
  ];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',      // Required to receive a refresh_token
    prompt: 'consent',           // Forces Google to always return refresh_token
    scope: scopes,
    state: userId,               // Pass userId through OAuth flow — returned in callback
  });
}

// ─── Step 2: Exchange Code for Tokens ────────────────────────────────────────
// Called in the OAuth callback with the `code` Google sends back.
// Stores tokens in MongoDB keyed by userId.

export async function exchangeCodeForTokens(code, userId) {
  const oauth2Client = getOAuthClient();

  const { tokens } = await oauth2Client.getToken(code);

  await GoogleToken.findOneAndUpdate(
    { userId },
    {
      userId,
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate:   tokens.expiry_date,
      scope:        tokens.scope,
      updatedAt:    new Date(),
    },
    { upsert: true, new: true }
  );

  return tokens;
}

// ─── Step 3: Get Authenticated Client for Any User ───────────────────────────
// Retrieves stored tokens, sets credentials, and auto-refreshes if expired.
// Use this before every Gmail / Calendar API call.

export async function getAuthenticatedClient(userId) {
  const stored = await GoogleToken.findOne({ userId });

  if (!stored) {
    throw new Error(`No Google tokens found for user ${userId}. User must connect Google first.`);
  }

  const oauth2Client = getOAuthClient();

  oauth2Client.setCredentials({
    access_token:  stored.accessToken,
    refresh_token: stored.refreshToken,
    expiry_date:   stored.expiryDate,
  });

  // If access token is expired or will expire in next 5 minutes, refresh it
  const fiveMinutes = 5 * 60 * 1000;
  const isExpired = stored.expiryDate && (stored.expiryDate - Date.now() < fiveMinutes);

  if (isExpired) {
    const { credentials } = await oauth2Client.refreshAccessToken();

    // Persist the new access token back to MongoDB
    await GoogleToken.findOneAndUpdate(
      { userId },
      {
        accessToken: credentials.access_token,
        expiryDate:  credentials.expiry_date,
        updatedAt:   new Date(),
      }
    );

    oauth2Client.setCredentials(credentials);
  }

  return oauth2Client;
}

// ─── Check if User Has Connected Google ──────────────────────────────────────
export async function isGoogleConnected(userId) {
  const token = await GoogleToken.findOne({ userId });
  return !!token?.refreshToken;
}