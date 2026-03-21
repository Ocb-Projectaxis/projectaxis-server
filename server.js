// ═══════════════════════════════════════════════════════════════════
// ProjectAxis — server.js
// Node.js + Express API replacing Google Apps Script entirely.
// Every function that was in Code.gs is now a route here.
// Deploy on Railway: railway up  (or any Node host)
// ═══════════════════════════════════════════════════════════════════
'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const authRouter     = require('./routes/auth');
const dataRouter     = require('./routes/data');
const writeRouter    = require('./routes/write');
const emailRouter    = require('./routes/email');
const { authMiddleware } = require('./middleware/auth');

const app = express();

// ── Supabase client (service role — full DB access) ──────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
// Attach to app so routes can use it via req.app.get('supabase')
app.set('supabase', supabase);

// ── Middleware ───────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json({ limit: '2mb' }));

// Rate limiting — prevent abuse
app.use('/api/auth', rateLimit({ windowMs: 15*60*1000, max: 20, message: { ok:false, error:'Too many login attempts' } }));
app.use('/api/',     rateLimit({ windowMs: 1*60*1000,  max: 120 }));

// ── Routes ───────────────────────────────────────────────────────
app.use('/api/auth',  authRouter);            // login, change password, users
app.use('/api/data',  authMiddleware, dataRouter);   // getData, getProgressOnly etc.
app.use('/api/write', authMiddleware, writeRouter);  // all mutations
app.use('/api/email', authMiddleware, emailRouter);  // reminders

// Health check
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ProjectAxis API running on port ${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL}`);
});

module.exports = app;
