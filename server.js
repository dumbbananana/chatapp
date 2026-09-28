/* ============================================================
   STUDENT OS — SINGLE SERVICE
   Serves the dashboard + handles OAuth, Gmail, Calendar
   ============================================================ */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

/* ---------- MIDDLEWARE ---------- */
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- IN-MEMORY TOKEN STORE ---------- */
// Wiped when the server sleeps — user clicks "Connect Google" again.
// Fine for personal use.
const tokenStore = new Map();

const saveTokens = (id, t) => tokenStore.set(id, { ...t, savedAt: Date.now() });
const getTokens = (id) => tokenStore.get(id) || null;
const deleteTokens = (id) => tokenStore.delete(id);

/* ---------- GOOGLE OAUTH ---------- */
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${APP_URL}/auth/callback`
  );
}

function getAuthenticatedClient(userId) {
  const tokens = getTokens(userId);
  if (!tokens) return null;
  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    saveTokens(userId, { ...tokens, ...newTokens });
    console.log(`↻ Refreshed tokens for ${userId}`);
  });
  return client;
}

/* ---------- HEALTH ---------- */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    connectedUsers: Array.from(tokenStore.keys())
  });
});

/* ---------- AUTH ROUTES ---------- */
app.get('/auth/login', (req, res) => {
  const client = createOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`/?auth=error&reason=${error || 'no_code'}`);
  }

  try {
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    const userId = me.data.email;

    saveTokens(userId, tokens);
    console.log(`✓ Auth success: ${userId}`);

    res.redirect(`/?auth=success&userId=${encodeURIComponent(userId)}`);
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect(`/?auth=error&reason=token_exchange`);
  }
});

app.post('/auth/logout', (req, res) => {
  const { userId } = req.body;
  if (userId) deleteTokens(userId);
  res.json({ ok: true });
});

app.get('/auth/status', (req, res) => {
  res.json({ users: Array.from(tokenStore.keys()) });
});

/* ---------- GMAIL ---------- */
app.get('/api/gmail/messages', async (req, res) => {
 const { userId, q = 'from:student.services@ing.edu.np OR from:rte@ing.edu.np', maxResults = 50 } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const auth = getAuthenticatedClient(userId);
  if (!auth) {
    return res.status(401).json({
      error: 'Not authenticated',
      hint: 'Click Connect Google again'
    });
  }

  try {
    const gmail = google.gmail({ version: 'v1', auth });

    const list = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: Math.min(Number(maxResults) || 20, 50)
    });

    const messages = list.data.messages || [];
    if (!messages.length) return res.json({ messages: [] });

    const detailed = await Promise.all(
      messages.map(async (msg) => {
        try {
          const full = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date']
          });

          const headers = Object.fromEntries(
            (full.data.payload?.headers || []).map(h => [
              h.name.toLowerCase(),
              h.value
            ])
          );

          const labels = full.data.labelIds || [];
          return {
            id: msg.id,
            from: headers.from || 'Unknown',
            subject: headers.subject || '(no subject)',
            date: headers.date || '',
            snippet: full.data.snippet || '',
            unread: labels.includes('UNREAD'),
            important: labels.includes('IMPORTANT')
          };
        } catch {
          return {
            id: msg.id,
            from: 'Unknown',
            subject: '(failed to load)',
            date: '',
            snippet: '',
            unread: false,
            important: false
          };
        }
      })
    );

    res.json({ messages: detailed });
  } catch (err) {
    console.error('Gmail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- CALENDAR ---------- */
app.get('/api/calendar/events', async (req, res) => {
  const { userId, days = 14 } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const auth = getAuthenticatedClient(userId);
  if (!auth) {
    return res.status(401).json({
      error: 'Not authenticated',
      hint: 'Click Connect Google again'
    });
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + Number(days) * 86400000).toISOString();

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });

    const events = (response.data.items || []).map(e => ({
      id: e.id,
      summary: e.summary || '(no title)',
      description: e.description || '',
      location: e.location || '',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      allDay: !e.start?.dateTime
    }));

    res.json({ events });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- SPA FALLBACK ---------- */
// Anything not matched above serves the dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---------- START ---------- */
app.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log(`  Student OS running on port ${PORT}`);
  console.log(`  URL: ${APP_URL}`);
  console.log('========================================');
  console.log('');
});