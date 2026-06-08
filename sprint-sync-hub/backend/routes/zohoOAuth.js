'use strict';

/**
 * Zoho OAuth routes — handles the authorization flow to generate a
 * refresh token with the correct scopes for Zoho People attendance.
 *
 * GET  /api/zoho/oauth/url       — returns the authorization URL to open in browser
 * GET  /api/zoho/oauth/callback  — receives the code from Zoho, exchanges it,
 *                                  saves the new refresh token to .env and cache
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const ENV_FILE        = path.join(__dirname, '..', '.env');
const TOKEN_CACHE_FILE = path.join(__dirname, '..', '.zoho_token_cache.json');

// Scopes needed:
//   ZOHOPEOPLE.attendance.READ  — check-in/out data
//   ZOHOPEOPLE.employee.READ    — employee lookup
//   ZohoCliq.users.READ         — presence (already working)
const SCOPES = [
  'ZOHOPEOPLE.attendance.READ',
  'ZOHOPEOPLE.attendance.ALL',
  'ZOHOPEOPLE.employee.READ',
  'ZohoCliq.users.READ',
].join(',');

function getClientId()     { return process.env.ZOHO_CLIENT_ID     || ''; }
function getClientSecret() { return process.env.ZOHO_CLIENT_SECRET || ''; }
function getDomain()       { return process.env.ZOHO_DOMAIN        || 'zoho.in'; }

// ─── GET /api/zoho/oauth/url ──────────────────────────────────────────────────

router.get('/url', (req, res) => {
  const clientId    = getClientId();
  const domain      = getDomain();
  const redirectUri = 'http://localhost:5174/zoho/callback';

  if (!clientId) {
    return res.status(400).json({ error: 'ZOHO_CLIENT_ID not set in .env' });
  }

  const authUrl = `https://accounts.${domain}/oauth/v2/auth?` + new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    scope:         SCOPES,
    redirect_uri:  redirectUri,
    access_type:   'offline',
    prompt:        'consent',   // forces Zoho to return a new refresh_token
  }).toString();

  res.json({
    authUrl,
    scopes:      SCOPES,
    redirectUri,
    instruction: 'Open authUrl in your browser, accept permissions, then you will be redirected back automatically.',
  });
});

// ─── GET /api/zoho/oauth/callback ─────────────────────────────────────────────
// Called by the frontend after Zoho redirects to localhost:5174/zoho/callback.
// The frontend extracts the code from the URL and posts it here.

router.post('/exchange', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  const clientId     = getClientId();
  const clientSecret = getClientSecret();
  const domain       = getDomain();
  const redirectUri  = 'http://localhost:5174/zoho/callback';

  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'ZOHO_CLIENT_ID or ZOHO_CLIENT_SECRET not set in .env' });
  }

  try {
    // Exchange authorization code for access + refresh tokens
    const response = await axios.post(
      `https://accounts.${domain}/oauth/v2/token`,
      null,
      {
        params: {
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
        },
        timeout: 15_000,
      }
    );

    const data = response.data;

    if (data.error) {
      return res.status(400).json({
        error:   `Zoho returned error: ${data.error}`,
        details: data,
      });
    }

    const newRefreshToken = data.refresh_token;
    const accessToken     = data.access_token;
    const expiresIn       = data.expires_in || 3600;

    if (!newRefreshToken) {
      return res.status(400).json({
        error:   'Zoho did not return a refresh_token — try opening the authUrl again with prompt=consent',
        details: data,
      });
    }

    // ── Save new refresh token to .env ────────────────────────────────────────
    try {
      let envContent = fs.readFileSync(ENV_FILE, 'utf8');
      if (envContent.includes('ZOHO_REFRESH_TOKEN=')) {
        envContent = envContent.replace(
          /ZOHO_REFRESH_TOKEN=.*/,
          `ZOHO_REFRESH_TOKEN=${newRefreshToken}`
        );
      } else {
        envContent += `\nZOHO_REFRESH_TOKEN=${newRefreshToken}\n`;
      }
      fs.writeFileSync(ENV_FILE, envContent, 'utf8');
      console.log('[ZohoOAuth] ✅ New refresh token saved to .env');
    } catch (err) {
      console.warn('[ZohoOAuth] Could not write to .env:', err.message);
    }

    // ── Update the in-memory env var so new requests use it immediately ───────
    process.env.ZOHO_REFRESH_TOKEN = newRefreshToken;

    // ── Save the new access token to disk cache so it's used right away ───────
    const expiresAt = Date.now() + expiresIn * 1_000;
    try {
      fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({
        token:     accessToken,
        expiresAt,
      }), 'utf8');

      // Also update the in-memory cache in zohoService
      const zohoService = require('../services/zohoService');
      if (typeof zohoService._setTokenCache === 'function') {
        zohoService._setTokenCache(accessToken, expiresAt);
      }
      console.log('[ZohoOAuth] ✅ Access token cached');
    } catch (err) {
      console.warn('[ZohoOAuth] Could not write token cache:', err.message);
    }

    console.log('[ZohoOAuth] ✅ OAuth complete. Scopes granted — restart server to apply new refresh token.');

    res.json({
      success:       true,
      message:       'New Zoho refresh token saved. Restart the server to apply.',
      tokenPrefix:   newRefreshToken.substring(0, 15) + '...',
      expiresIn,
      scopesGranted: SCOPES,
    });

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[ZohoOAuth] Exchange failed:', detail);
    res.status(500).json({ error: `Token exchange failed: ${detail}` });
  }
});

module.exports = router;
