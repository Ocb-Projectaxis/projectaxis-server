// ═══════════════════════════════════════════════════════════════════
// ProjectAxis — server.js  (single-file version for Railway)
// All routes and middleware are inline — no subfolders needed.
// ═══════════════════════════════════════════════════════════════════
'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── Supabase client ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
app.set('supabase', supabase);

// ── Middleware ────────────────────────────────────────────────────
// CORS — allow all origins (change FRONTEND_URL to restrict later)
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false
}));
// Handle preflight OPTIONS requests explicitly
app.options('*', cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15*60*1000, max: 20, message: { ok:false, error:'Too many login attempts' } }));
app.use('/api/',     rateLimit({ windowMs: 1*60*1000,  max: 120 }));

// ════════════════════════════════════════════════════════════════
// AUTH HELPERS
// ════════════════════════════════════════════════════════════════
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Session expired — please log in again' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Access denied for your role' });
    next();
  };
}

const isSupervisor = (u) => u?.role === 'supervisor';

// ════════════════════════════════════════════════════════════════
// DATA HELPERS
// ════════════════════════════════════════════════════════════════
function calcStatus(pct) {
  if (pct >= 100) return 'Completed';
  if (pct === 0)  return 'Delayed';
  if (pct < 30)   return 'At Risk';
  if (pct < 50)   return 'Delayed';
  return 'On Track';
}

function calcAllProgress(progressRows) {
  const map = {}, totals = {};
  for (const row of progressRows) {
    const sid = String(row.student_id);
    if (!map[sid]) map[sid] = { points: 0 };
    if (!totals[sid]) totals[sid] = 0;
    totals[sid]++;
    if (row.done === 2) map[sid].points += 1;
    else if (row.done === 1) map[sid].points += 0.5;
  }
  const result = {};
  for (const [sid, data] of Object.entries(map)) {
    const pct = Math.round(data.points / (totals[sid] || 1) * 100);
    result[sid] = { pct, status: calcStatus(pct) };
  }
  return result;
}

const mapCohort     = r => ({ ID: String(r.id), Name: r.name, Semester: r.semester, Programme: r.programme, Unit: r.unit, StartDate: r.start_date||'', EndDate: r.end_date||'', Status: r.status, Level: r.level });
const mapStudent    = r => ({ ID: String(r.id), CohortID: String(r.cohort_id), Name: r.name, RegNo: r.reg_no, Email: r.email, SupervisorID: r.supervisor_id ? String(r.supervisor_id) : '', Title: r.title, StartDate: r.start_date||'', EndDate: r.end_date||'', Status: r.status, Progress: r.progress, Mobile: r.mobile, Programme: r.programme, Specialisation: r.specialisation });
const mapMilestone  = r => ({ ID: String(r.id), CohortID: String(r.cohort_id), Order: r.order, Name: r.name, WeekOffset: r.week_offset||'' });
const mapProgress   = r => ({ StudentID: String(r.student_id), MilestoneID: String(r.milestone_id), Done: r.done, Date: r.date||'', UpdatedBy: r.updated_by });
const mapLog        = r => ({ ID: String(r.id), StudentID: String(r.student_id), CohortID: String(r.cohort_id), Date: r.date||'', Note: r.note, By: r.by, Type: r.type });
const mapSession    = r => ({ ID: String(r.id), StudentID: String(r.student_id), MilestoneID: r.milestone_id ? String(r.milestone_id) : '', SessionDate: r.session_date||'', Attended: r.attended, Notes: r.notes, RecordedBy: r.recorded_by });
const mapSupervisor = r => ({ ID: String(r.id), Name: r.name, Email: r.email, Department: r.department });
const mapProgramme  = r => ({ ID: String(r.id), Name: r.name, Code: r.code, Units: r.units });

async function recalcStudent(sb, studentId) {
  const { data: rows } = await sb.from('progress').select('done').eq('student_id', studentId);
  if (!rows || !rows.length) {
    await sb.from('students').update({ status: 'Delayed', progress: 0 }).eq('id', studentId);
    return { pct: 0, status: 'Delayed' };
  }
  const points = rows.reduce((a, r) => a + (r.done === 2 ? 1 : r.done === 1 ? 0.5 : 0), 0);
  const pct    = Math.round(points / rows.length * 100);
  const status = calcStatus(pct);
  await sb.from('students').update({ status, progress: pct }).eq('id', studentId);
  return { pct, status };
}

function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`{{${k}}}`, 'g'), v||'');
  out = out.replace(/\{\{#supervisorName\}\}([\s\S]*?)\{\{\/supervisorName\}\}/g, vars.supervisorName ? '$1' : '');
  return out;
}

// ════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ════════════════════════════════════════════════════════════════
// DEBUG ENDPOINT — remove after fixing login
// ════════════════════════════════════════════════════════════════
app.get('/api/debug/login-test', async (req, res) => {
  const sb = req.app.get('supabase');
  try {
    // Step 1: Find user
    const { data: users, error: dbErr } = await sb
      .from('users')
      .select('id,username,password_hash,role,active')
      .ilike('username', 'admin')
      .limit(1);
    // ONE-TIME hash generator — remove after use
app.get('/api/debug/make-hash', async (req, res) => {
  const hash = await bcrypt.hash('admin123', 10);
  res.json({ hash });
});
```
if (dbErr) return res.json({ step: 'db_query', error: dbErr.message });
    if (!users?.length) return res.json({ step: 'user_lookup', error: 'User not found' });

    const user = users[0];

    // Step 2: Test bcrypt
    const match = await bcrypt.compare('admin123', user.password_hash);

    return res.json({
      step: 'complete',
      userFound: true,
      username: user.username,
      role: user.role,
      active: user.active,
      hashLength: user.password_hash.length,
      passwordMatch: match
    });
  } catch (e) {
    return res.json({ step: 'exception', error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// AUTH ROUTES  /api/auth/...
// ════════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });
  const sb = req.app.get('supabase');
  const { data: users } = await sb.from('users').select('id,username,password_hash,role,full_name,email,active,supervisor_id').ilike('username', username.trim()).limit(1);
  if (!users?.length) return res.json({ ok: false, error: 'Invalid username or password' });
  const user = users[0];
  if (!user.active) return res.json({ ok: false, error: 'Account is inactive — contact your administrator' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.json({ ok: false, error: 'Invalid username or password' });
  await sb.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
  const payload = { id: user.id, username: user.username, role: user.role, fullName: user.full_name, email: user.email, supervisorId: user.supervisor_id ? String(user.supervisor_id) : '' };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
  return res.json({ ok: true, token, user: payload });
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.json({ ok: false, error: 'Both passwords required' });
  if (newPassword.length < 6) return res.json({ ok: false, error: 'New password must be at least 6 characters' });
  const sb = req.app.get('supabase');
  const { data: users } = await sb.from('users').select('id,password_hash').eq('id', req.user.id).limit(1);
  if (!users?.length) return res.json({ ok: false, error: 'User not found' });
  if (!await bcrypt.compare(oldPassword, users[0].password_hash)) return res.json({ ok: false, error: 'Current password is incorrect' });
  await sb.from('users').update({ password_hash: await bcrypt.hash(newPassword, 10) }).eq('id', req.user.id);
  return res.json({ ok: true });
});

// POST /api/auth/admin-reset-password
app.post('/api/auth/admin-reset-password', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword || newPassword.length < 6) return res.json({ ok: false, error: 'userId and newPassword (min 6 chars) required' });
  const { error } = await req.app.get('supabase').from('users').update({ password_hash: await bcrypt.hash(newPassword, 10) }).eq('id', userId);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

// GET /api/auth/users
app.get('/api/auth/users', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { data, error } = await req.app.get('supabase').from('users').select('id,username,role,full_name,email,last_login,active,supervisor_id').order('id');
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true, users: data.map(u => ({ id: u.id, username: u.username, role: u.role, fullName: u.full_name, email: u.email, lastLogin: u.last_login, active: u.active, supervisorId: u.supervisor_id ? String(u.supervisor_id) : '' })) });
});

// POST /api/auth/save-user
app.post('/api/auth/save-user', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { id, username, password, role, fullName, email, active, supervisorId } = req.body;
  if (!username || !role || !fullName) return res.json({ ok: false, error: 'Username, role and full name required' });
  const validRoles = ['sysadmin','coordinator','programme_head','supervisor','viewer'];
  if (!validRoles.includes(role)) return res.json({ ok: false, error: 'Invalid role' });
  const sb = req.app.get('supabase');
  if (id) {
    const update = { username: username.trim(), role, full_name: fullName, email: email||'', active: active !== false, supervisor_id: supervisorId ? Number(supervisorId) : null };
    if (password) update.password_hash = await bcrypt.hash(password, 10);
    const { error } = await sb.from('users').update(update).eq('id', id);
    return res.json(error ? { ok: false, error: error.message } : { ok: true });
  } else {
    if (!password) return res.json({ ok: false, error: 'Password required for new user' });
    const { data: ex } = await sb.from('users').select('id').ilike('username', username.trim()).limit(1);
    if (ex?.length) return res.json({ ok: false, error: 'Username already exists' });
    const { error } = await sb.from('users').insert({ username: username.trim(), password_hash: await bcrypt.hash(password, 10), role, full_name: fullName, email: email||'', active: true, supervisor_id: supervisorId ? Number(supervisorId) : null });
    return res.json(error ? { ok: false, error: error.message } : { ok: true });
  }
});

// POST /api/auth/delete-user
app.post('/api/auth/delete-user', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { error } = await req.app.get('supabase').from('users').delete().eq('id', req.body.id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

// ════════════════════════════════════════════════════════════════
// DATA ROUTES  /api/data/...
// ════════════════════════════════════════════════════════════════

// GET /api/data/boot
app.get('/api/data/boot', authMiddleware, async (req, res) => {
  const sb = req.app.get('supabase');
  try {
    const [
      { data: cohorts }, { data: students }, { data: milestones },
      { data: progress }, { data: logs }, { data: sessions },
      { data: supervisors }, { data: programmes }, { data: settings }
    ] = await Promise.all([
      sb.from('cohorts').select('*').order('id'),
      sb.from('students').select('*').order('id'),
      sb.from('milestones').select('*').order('cohort_id').order('order'),
      sb.from('progress').select('*'),
      sb.from('logs').select('*').order('date', { ascending: false }),
      sb.from('sessions').select('*'),
      sb.from('supervisors').select('*').order('id'),
      sb.from('programmes').select('*').order('id'),
      sb.from('settings').select('*')
    ]);
    const progCalc = calcAllProgress(progress || []);
    const mappedStudents = (students || []).map(s => { const c = progCalc[String(s.id)]; return { ...mapStudent(s), Progress: c ? c.pct : s.progress, Status: c ? c.status : s.status }; });
    const settingsObj = {};
    for (const row of (settings || [])) settingsObj[row.key] = row.value;
    const doneSum = (progress||[]).reduce((a, p) => a + p.done, 0);
    const token = `${(progress||[]).length}_${(students||[]).length}_${(cohorts||[]).length}_${doneSum}`;
    return res.json({ ok: true, ping: 'WORKS', token, cohorts: (cohorts||[]).map(mapCohort), students: mappedStudents, milestones: (milestones||[]).map(mapMilestone), progress: (progress||[]).map(mapProgress), logs: (logs||[]).map(mapLog), sessions: (sessions||[]).map(mapSession), supervisors: (supervisors||[]).map(mapSupervisor), programmes: (programmes||[]).map(mapProgramme), settings: settingsObj });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/data/boot-supervisor
app.get('/api/data/boot-supervisor', authMiddleware, async (req, res) => {
  const supId = req.user.supervisorId ? Number(req.user.supervisorId) : null;
  if (!supId) return res.json({ ok: false, error: 'No Supervisor ID linked to your account.' });
  const sb = req.app.get('supabase');
  try {
    const { data: myStudents } = await sb.from('students').select('*').eq('supervisor_id', supId).order('id');
    const studentIds = (myStudents || []).map(s => s.id);
    const [
      { data: cohorts }, { data: milestones }, { data: progress },
      { data: logs }, { data: sessions }, { data: supervisors },
      { data: programmes }, { data: settings }
    ] = await Promise.all([
      sb.from('cohorts').select('*').order('id'),
      sb.from('milestones').select('*').order('cohort_id').order('order'),
      studentIds.length ? sb.from('progress').select('*').in('student_id', studentIds) : Promise.resolve({ data: [] }),
      studentIds.length ? sb.from('logs').select('*').in('student_id', studentIds).order('date', { ascending: false }) : Promise.resolve({ data: [] }),
      studentIds.length ? sb.from('sessions').select('*').in('student_id', studentIds) : Promise.resolve({ data: [] }),
      sb.from('supervisors').select('*').order('id'),
      sb.from('programmes').select('*').order('id'),
      sb.from('settings').select('*')
    ]);
    const progCalc = calcAllProgress(progress || []);
    const mappedStudents = (myStudents || []).map(s => { const c = progCalc[String(s.id)]; return { ...mapStudent(s), Progress: c ? c.pct : s.progress, Status: c ? c.status : s.status }; });
    const settingsObj = {};
    for (const row of (settings || [])) settingsObj[row.key] = row.value;
    const doneSum = (progress||[]).reduce((a,p) => a + p.done, 0);
    const token = `${(progress||[]).length}_${(myStudents||[]).length}_${(cohorts||[]).length}_${doneSum}`;
    return res.json({ ok: true, token, cohorts: (cohorts||[]).map(mapCohort), students: mappedStudents, milestones: (milestones||[]).map(mapMilestone), progress: (progress||[]).map(mapProgress), logs: (logs||[]).map(mapLog), sessions: (sessions||[]).map(mapSession), supervisors: (supervisors||[]).map(mapSupervisor), programmes: (programmes||[]).map(mapProgramme), settings: settingsObj });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/data/progress-only
app.get('/api/data/progress-only', authMiddleware, async (req, res) => {
  const sb = req.app.get('supabase');
  try {
    let pq = sb.from('progress').select('student_id,milestone_id,done,date,updated_by');
    let sq = sb.from('students').select('id,cohort_id,name,reg_no,email,supervisor_id,title,start_date,end_date,status,progress,mobile,programme,specialisation');
    if (isSupervisor(req.user) && req.user.supervisorId) {
      const { data: ids } = await sb.from('students').select('id').eq('supervisor_id', Number(req.user.supervisorId));
      const idList = (ids||[]).map(s => s.id);
      if (idList.length) { pq = pq.in('student_id', idList); sq = sq.in('id', idList); }
    }
    const [{ data: progress }, { data: students }] = await Promise.all([pq, sq]);
    const progCalc = calcAllProgress(progress || []);
    const mappedStudents = (students||[]).map(s => { const c = progCalc[String(s.id)]; return { ...mapStudent(s), Progress: c ? c.pct : s.progress, Status: c ? c.status : s.status }; });
    const doneSum = (progress||[]).reduce((a,p) => a + p.done, 0);
    return res.json({ ok: true, token: `${(progress||[]).length}_${(students||[]).length}_${doneSum}`, progress: (progress||[]).map(mapProgress), students: mappedStudents });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/data/change-token
app.get('/api/data/change-token', authMiddleware, async (req, res) => {
  const sb = req.app.get('supabase');
  try {
    const [{ count: pr },{ count: st },{ count: co },{ count: ms },{ count: lg }] = await Promise.all([
      sb.from('progress').select('id',{count:'exact',head:true}),
      sb.from('students').select('id',{count:'exact',head:true}),
      sb.from('cohorts').select('id',{count:'exact',head:true}),
      sb.from('milestones').select('id',{count:'exact',head:true}),
      sb.from('logs').select('id',{count:'exact',head:true})
    ]);
    const { data: done } = await sb.from('progress').select('done');
    const doneSum = (done||[]).reduce((a,p) => a + p.done, 0);
    return res.json({ ok: true, token: `${pr}_${st}_${co}_${ms}_${lg}_${doneSum}` });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/data/deadlines
app.get('/api/data/deadlines', authMiddleware, async (req, res) => {
  const sb = req.app.get('supabase');
  const { data: settings } = await sb.from('settings').select('key,value');
  const cfg = {}; for (const s of (settings||[])) cfg[s.key] = s.value;
  const warnDays = parseInt(cfg.deadlineWarnDays || '14', 10);
  const today = new Date(); today.setHours(0,0,0,0);
  const warnDate = new Date(today); warnDate.setDate(warnDate.getDate() + warnDays);
  try {
    const { data: milestones } = await sb.from('milestones').select('id,cohort_id,name,week_offset').not('week_offset','is',null);
    const { data: cohorts } = await sb.from('cohorts').select('id,name').eq('status','Active');
    const { data: students } = await sb.from('students').select('id,cohort_id,supervisor_id');
    const { data: progress } = await sb.from('progress').select('student_id,milestone_id,done');
    const cohortMap = {}; for (const c of (cohorts||[])) cohortMap[c.id] = c.name;
    const progressMap = {}; for (const p of (progress||[])) progressMap[`${p.student_id}_${p.milestone_id}`] = p.done;
    const activeCids = new Set((cohorts||[]).map(c => String(c.id)));
    const alerts = [];
    for (const ms of (milestones||[])) {
      if (!activeCids.has(String(ms.cohort_id)) || !ms.week_offset) continue;
      const dueDate = new Date(ms.week_offset); dueDate.setHours(0,0,0,0);
      if (dueDate > warnDate) continue;
      const pending = (students||[]).filter(s => String(s.cohort_id) === String(ms.cohort_id) && (progressMap[`${s.id}_${ms.id}`]||0) < 2);
      if (!pending.length) continue;
      alerts.push({ milestoneId: String(ms.id), milestoneName: ms.name, cohortId: String(ms.cohort_id), cohortName: cohortMap[ms.cohort_id]||'—', dueDate: ms.week_offset, daysUntilDue: Math.round((dueDate - today) / 86400000), pendingCount: pending.length });
    }
    alerts.sort((a,b) => a.daysUntilDue - b.daysUntilDue);
    return res.json({ ok: true, alerts, warnDays });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// WRITE ROUTES  /api/write/...
// ════════════════════════════════════════════════════════════════

// Cohorts
app.post('/api/write/cohort/add', authMiddleware, requireRole('sysadmin','coordinator'), async (req, res) => {
  const { name, semester, programme, unit, startDate, endDate, level } = req.body;
  if (!name || !semester) return res.json({ ok: false, error: 'Name and semester required' });
  const sb = req.app.get('supabase');
  const { data: cohort, error: ce } = await sb.from('cohorts').insert({ name, semester, programme: programme||'', unit: unit||'', start_date: startDate||null, end_date: endDate||null, status: 'Active', level: level||'PG' }).select().single();
  if (ce) return res.json({ ok: false, error: ce.message });
  const dms = ['Proposal','Literature Review','Methodology','Data Collection','Analysis','Draft','Final Submission'];
  await sb.from('milestones').insert(dms.map((n,i) => ({ cohort_id: cohort.id, order: i+1, name: n })));
  return res.json({ ok: true, id: String(cohort.id) });
});

app.post('/api/write/cohort/update', authMiddleware, requireRole('sysadmin','coordinator'), async (req, res) => {
  const { id, name, semester, programme, unit, startDate, endDate, status, level } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const { error } = await req.app.get('supabase').from('cohorts').update({ name, semester, programme: programme||'', unit: unit||'', start_date: startDate||null, end_date: endDate||null, status, level: level||'PG' }).eq('id', id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

app.post('/api/write/cohort/delete', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { error } = await req.app.get('supabase').from('cohorts').delete().eq('id', req.body.id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

// Students
app.post('/api/write/student/add', authMiddleware, requireRole('sysadmin','coordinator'), async (req, res) => {
  const { cohortId, name, regNo, email, supervisorId, title, mobile, programme, specialisation } = req.body;
  if (!cohortId || !name || !regNo) return res.json({ ok: false, error: 'cohortId, name, regNo required' });
  const sb = req.app.get('supabase');
  const { data: cohort } = await sb.from('cohorts').select('start_date,end_date').eq('id', cohortId).single();
  const { data: student, error: se } = await sb.from('students').insert({ cohort_id: Number(cohortId), name, reg_no: regNo, email: email||'', supervisor_id: supervisorId ? Number(supervisorId) : null, title: title||'', mobile: mobile||'', programme: programme||'', specialisation: specialisation||'', start_date: cohort?.start_date||null, end_date: cohort?.end_date||null, status: 'Delayed', progress: 0 }).select().single();
  if (se) return res.json({ ok: false, error: se.message });
  const { data: milestones } = await sb.from('milestones').select('id').eq('cohort_id', cohortId);
  if (milestones?.length) await sb.from('progress').insert(milestones.map(m => ({ student_id: student.id, milestone_id: m.id, done: 0, updated_by: '' })));
  return res.json({ ok: true, id: String(student.id) });
});

app.post('/api/write/student/update', authMiddleware, requireRole('sysadmin','coordinator'), async (req, res) => {
  const { id, name, regNo, email, title, cohortId, supervisorId, mobile, programme, specialisation } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const { error } = await req.app.get('supabase').from('students').update({ name, reg_no: regNo, email: email||'', title: title||'', cohort_id: Number(cohortId), supervisor_id: supervisorId ? Number(supervisorId) : null, mobile: mobile||'', programme: programme||'', specialisation: specialisation||'' }).eq('id', id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

app.post('/api/write/student/update-status', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { id, status, progressPct } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const update = { status };
  if (progressPct !== null && progressPct !== undefined) update.progress = Number(progressPct);
  const { error } = await req.app.get('supabase').from('students').update(update).eq('id', id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

app.post('/api/write/student/bulk-add', authMiddleware, requireRole('sysadmin','coordinator'), async (req, res) => {
  const { cohortId, rows } = req.body;
  if (!cohortId || !rows?.length) return res.json({ ok: false, error: 'cohortId and rows required' });
  const sb = req.app.get('supabase');
  const { data: cohort } = await sb.from('cohorts').select('start_date,end_date').eq('id', cohortId).single();
  const { data: milestones } = await sb.from('milestones').select('id').eq('cohort_id', cohortId);
  const { data: existing } = await sb.from('students').select('reg_no');
  const existingSet = new Set((existing||[]).map(s => s.reg_no.toLowerCase()));
  let added = 0, skipped = 0; const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.name || !r.regNo) { errors.push(`Row ${i+1}: name/regNo missing`); continue; }
    const key = r.regNo.trim().toLowerCase();
    if (existingSet.has(key)) { errors.push(`Row ${i+1}: RegNo ${r.regNo} exists`); skipped++; continue; }
    const { data: student, error: se } = await sb.from('students').insert({ cohort_id: Number(cohortId), name: r.name, reg_no: r.regNo, email: r.email||'', supervisor_id: r.supervisorId ? Number(r.supervisorId) : null, title: r.title||'', mobile: r.mobile||'', programme: r.programme||'', specialisation: r.specialisation||'', start_date: cohort?.start_date||null, end_date: cohort?.end_date||null, status: 'Delayed', progress: 0 }).select().single();
    if (se) { errors.push(`Row ${i+1}: ${se.message}`); continue; }
    if (milestones?.length) await sb.from('progress').insert(milestones.map(m => ({ student_id: student.id, milestone_id: m.id, done: 0, updated_by: '' })));
    existingSet.add(key); added++;
  }
  return res.json({ ok: true, added, skipped, errors });
});

// Milestones
app.post('/api/write/milestones/save', authMiddleware, requireRole('sysadmin','coordinator'), async (req, res) => {
  const { cohortId, milestones } = req.body;
  if (!cohortId || !milestones?.length) return res.json({ ok: false, error: 'cohortId and milestones required' });
  const sb = req.app.get('supabase');
  const { data: oldMs } = await sb.from('milestones').select('id').eq('cohort_id', cohortId);
  if (oldMs?.length) await sb.from('milestones').delete().in('id', oldMs.map(m => m.id));
  const { data: inserted } = await sb.from('milestones').insert(milestones.map((m,i) => ({ cohort_id: Number(cohortId), order: i+1, name: m.name, week_offset: m.weekOffset||null }))).select();
  const { data: students } = await sb.from('students').select('id').eq('cohort_id', cohortId);
  if (students?.length && inserted?.length) {
    const progressRows = [];
    for (const s of students) for (const m of inserted) progressRows.push({ student_id: s.id, milestone_id: m.id, done: 0, updated_by: '' });
    await sb.from('progress').insert(progressRows);
  }
  return res.json({ ok: true });
});

// Progress tick
app.post('/api/write/tick', authMiddleware, async (req, res) => {
  const { studentId, milestoneId, doneVal, updatedBy } = req.body;
  if (!studentId || !milestoneId) return res.json({ ok: false, error: 'studentId and milestoneId required' });
  const sb = req.app.get('supabase');
  const { error } = await sb.from('progress').upsert({ student_id: Number(studentId), milestone_id: Number(milestoneId), done: Number(doneVal), date: Number(doneVal) > 0 ? new Date().toISOString().slice(0,10) : null, updated_by: updatedBy||'' }, { onConflict: 'student_id,milestone_id' });
  if (error) return res.json({ ok: false, error: error.message });
  const calc = await recalcStudent(sb, Number(studentId));
  return res.json({ ok: true, progress: calc.pct, status: calc.status });
});

// Logs
app.post('/api/write/log/add', authMiddleware, requireRole('sysadmin','coordinator','programme_head'), async (req, res) => {
  const { studentId, cohortId, note, by, type } = req.body;
  if (!studentId || !cohortId || !note) return res.json({ ok: false, error: 'studentId, cohortId, note required' });
  const { error } = await req.app.get('supabase').from('logs').insert({ student_id: Number(studentId), cohort_id: Number(cohortId), date: new Date().toISOString().slice(0,10), note, by: by||'Admin', type: type||'Update' });
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

app.post('/api/write/log/delete', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { error } = await req.app.get('supabase').from('logs').delete().eq('id', req.body.id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

// Sessions
app.post('/api/write/session/save', authMiddleware, async (req, res) => {
  const { id, studentId, milestoneId, sessionDate, attended, notes, recordedBy } = req.body;
  if (!studentId) return res.json({ ok: false, error: 'studentId required' });
  const data = { student_id: Number(studentId), milestone_id: milestoneId ? Number(milestoneId) : null, session_date: sessionDate||null, attended: Number(attended)||3, notes: notes||'', recorded_by: recordedBy||'' };
  const { error } = id ? await req.app.get('supabase').from('sessions').update(data).eq('id', id) : await req.app.get('supabase').from('sessions').insert(data);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

app.post('/api/write/session/delete', authMiddleware, async (req, res) => {
  const { error } = await req.app.get('supabase').from('sessions').delete().eq('id', req.body.id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

// Supervisors
app.post('/api/write/supervisor/save', authMiddleware, requireRole('sysadmin','coordinator'), async (req, res) => {
  const { id, name, email, department } = req.body;
  if (!name) return res.json({ ok: false, error: 'name required' });
  const data = { name, email: email||'', department: department||'' };
  const { error } = id ? await req.app.get('supabase').from('supervisors').update(data).eq('id', id) : await req.app.get('supabase').from('supervisors').insert(data);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

app.post('/api/write/supervisor/delete', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { error } = await req.app.get('supabase').from('supervisors').delete().eq('id', req.body.id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

// Programmes
app.post('/api/write/programme/save', authMiddleware, requireRole('sysadmin','coordinator'), async (req, res) => {
  const { id, name, code, units } = req.body;
  if (!name) return res.json({ ok: false, error: 'name required' });
  const data = { name, code: code||'', units: units||'' };
  const { error } = id ? await req.app.get('supabase').from('programmes').update(data).eq('id', id) : await req.app.get('supabase').from('programmes').insert(data);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

app.post('/api/write/programme/delete', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { error } = await req.app.get('supabase').from('programmes').delete().eq('id', req.body.id);
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

// Settings
app.post('/api/write/settings', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const settings = req.body;
  if (!settings || typeof settings !== 'object') return res.json({ ok: false, error: 'settings object required' });
  const rows = Object.entries(settings).map(([key, value]) => ({ key, value: String(value) }));
  const { error } = await req.app.get('supabase').from('settings').upsert(rows, { onConflict: 'key' });
  return res.json(error ? { ok: false, error: error.message } : { ok: true });
});

// ════════════════════════════════════════════════════════════════
// EMAIL ROUTES  /api/email/...
// ════════════════════════════════════════════════════════════════

app.post('/api/email/remind-milestone', authMiddleware, requireRole('sysadmin','coordinator','programme_head'), async (req, res) => {
  const { milestoneId, dryRun } = req.body;
  const sb = req.app.get('supabase');
  const { data: settings } = await sb.from('settings').select('key,value');
  const cfg = {}; for (const s of (settings||[])) cfg[s.key] = s.value;
  const institution = cfg.institution || process.env.INSTITUTION || 'Your Institution';
  const subjectTpl = cfg.emailSubject || '[{{institution}}] Reminder: {{milestoneName}} due {{dueDate}}';
  const bodyTpl = cfg.emailBody || 'Dear {{studentName}},\n\nReminder: {{milestoneName}} is due {{dueDate}}.\n\nBest regards,\n{{institution}}';
  let msQuery = sb.from('milestones').select('id,cohort_id,name,week_offset');
  if (milestoneId) msQuery = msQuery.eq('id', milestoneId);
  const { data: milestones } = await msQuery;
  const { data: students } = await sb.from('students').select('id,cohort_id,name,email,supervisor_id');
  const { data: supervisors } = await sb.from('supervisors').select('id,name,email');
  const { data: progress } = await sb.from('progress').select('student_id,milestone_id,done');
  const { data: cohorts } = await sb.from('cohorts').select('id,name').eq('status','Active');
  const supMap = {}; for (const s of (supervisors||[])) supMap[s.id] = s;
  const cohortMap = {}; for (const c of (cohorts||[])) cohortMap[c.id] = c.name;
  const progressMap = {}; for (const p of (progress||[])) progressMap[`${p.student_id}_${p.milestone_id}`] = p.done;
  const activeCids = new Set((cohorts||[]).map(c => String(c.id)));
  const transport = dryRun ? null : makeTransport();
  let sent = 0, skipped = 0; const errors = [];
  for (const ms of (milestones||[])) {
    if (!activeCids.has(String(ms.cohort_id))) continue;
    for (const st of (students||[]).filter(s => String(s.cohort_id) === String(ms.cohort_id))) {
      if ((progressMap[`${st.id}_${ms.id}`]||0) >= 2 || !st.email) { skipped++; continue; }
      const sup = st.supervisor_id ? supMap[st.supervisor_id] : null;
      const vars = { studentName: st.name, milestoneName: ms.name, cohortName: cohortMap[ms.cohort_id]||'—', dueDate: ms.week_offset||'TBD', institution, supervisorName: sup?.name||'', supervisorEmail: sup?.email||'' };
      if (!dryRun) {
        try { await transport.sendMail({ from: `"${institution}" <${cfg.adminEmail||process.env.SMTP_FROM}>`, to: st.email, subject: fillTemplate(subjectTpl, vars), text: fillTemplate(bodyTpl, vars) }); sent++; }
        catch (e) { errors.push(`${st.name}: ${e.message}`); }
      } else { sent++; }
    }
  }
  return res.json({ ok: true, sent, skipped, errors, dryRun: !!dryRun });
});

app.post('/api/email/remind-student', authMiddleware, requireRole('sysadmin','coordinator','programme_head'), async (req, res) => {
  const { studentId, milestoneId } = req.body;
  const sb = req.app.get('supabase');
  const [{ data: student }, { data: ms }, { data: settings }] = await Promise.all([
    sb.from('students').select('id,name,email,cohort_id,supervisor_id').eq('id', studentId).single(),
    sb.from('milestones').select('id,name,week_offset').eq('id', milestoneId).single(),
    sb.from('settings').select('key,value')
  ]);
  if (!student?.email) return res.json({ ok: false, error: 'Student has no email address' });
  const cfg = {}; for (const s of (settings||[])) cfg[s.key] = s.value;
  const { data: cohort } = await sb.from('cohorts').select('name').eq('id', student.cohort_id).single();
  const { data: supervisor } = student.supervisor_id ? await sb.from('supervisors').select('name,email').eq('id', student.supervisor_id).single() : { data: null };
  const institution = cfg.institution || process.env.INSTITUTION;
  const vars = { studentName: student.name, milestoneName: ms?.name||'—', cohortName: cohort?.name||'—', dueDate: ms?.week_offset||'TBD', institution, supervisorName: supervisor?.name||'', supervisorEmail: supervisor?.email||'' };
  try {
    await makeTransport().sendMail({ from: `"${institution}" <${cfg.adminEmail||process.env.SMTP_FROM}>`, to: student.email, subject: fillTemplate(cfg.emailSubject||'[{{institution}}] Reminder: {{milestoneName}} due {{dueDate}}', vars), text: fillTemplate(cfg.emailBody||'Dear {{studentName}}, reminder for {{milestoneName}}.', vars) });
    return res.json({ ok: true });
  } catch (e) { return res.json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProjectAxis API running on port ${PORT}`));
module.exports = app;
