// ── routes/auth.js ───────────────────────────────────────────────
// login, getUsers, saveUser, deleteUser, changePassword, adminResetPassword
'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { authMiddleware, requireRole, canManageUsers } = require('../middleware/auth');

// ── POST /api/auth/login ─────────────────────────────────────────
// Replaces: loginUser(username, password)
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });

  const sb = req.app.get('supabase');
  const { data: users, error } = await sb
    .from('users')
    .select('id, username, password_hash, role, full_name, email, active, supervisor_id')
    .ilike('username', username.trim())
    .limit(1);

  if (error || !users?.length) return res.json({ ok: false, error: 'Invalid username or password' });
  const user = users[0];
  if (!user.active) return res.json({ ok: false, error: 'Account is inactive — contact your administrator' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.json({ ok: false, error: 'Invalid username or password' });

  // Update last_login
  await sb.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

  const payload = {
    id: user.id, username: user.username, role: user.role,
    fullName: user.full_name, email: user.email,
    supervisorId: user.supervisor_id ? String(user.supervisor_id) : ''
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });

  return res.json({ ok: true, token, user: payload });
});

// ── POST /api/auth/change-password ───────────────────────────────
// Replaces: changePassword(username, oldPassword, newPassword)
router.post('/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.json({ ok: false, error: 'Both passwords required' });
  if (newPassword.length < 6) return res.json({ ok: false, error: 'New password must be at least 6 characters' });

  const sb = req.app.get('supabase');
  const { data: users } = await sb.from('users').select('id, password_hash').eq('id', req.user.id).limit(1);
  if (!users?.length) return res.json({ ok: false, error: 'User not found' });

  const match = await bcrypt.compare(oldPassword, users[0].password_hash);
  if (!match) return res.json({ ok: false, error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(newPassword, 10);
  await sb.from('users').update({ password_hash: hash }).eq('id', req.user.id);
  return res.json({ ok: true });
});

// ── POST /api/auth/admin-reset-password ──────────────────────────
// Replaces: adminResetPassword(userId, newPassword)
router.post('/admin-reset-password', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword) return res.json({ ok: false, error: 'userId and newPassword required' });
  if (newPassword.length < 6) return res.json({ ok: false, error: 'Password must be at least 6 characters' });

  const hash = await bcrypt.hash(newPassword, 10);
  const sb = req.app.get('supabase');
  const { error } = await sb.from('users').update({ password_hash: hash }).eq('id', userId);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// ── GET /api/auth/users ──────────────────────────────────────────
// Replaces: getUsers()
router.get('/users', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const sb = req.app.get('supabase');
  const { data, error } = await sb
    .from('users')
    .select('id, username, role, full_name, email, last_login, active, supervisor_id')
    .order('id');
  if (error) return res.json({ ok: false, error: error.message });
  const users = data.map(u => ({
    id: u.id, username: u.username, role: u.role, fullName: u.full_name,
    email: u.email, lastLogin: u.last_login, active: u.active,
    supervisorId: u.supervisor_id ? String(u.supervisor_id) : ''
  }));
  return res.json({ ok: true, users });
});

// ── POST /api/auth/save-user ─────────────────────────────────────
// Replaces: saveUser(id, username, password, role, fullName, email, active, supervisorId)
router.post('/save-user', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { id, username, password, role, fullName, email, active, supervisorId } = req.body;
  if (!username || !role || !fullName) return res.json({ ok: false, error: 'Username, role and full name are required' });

  const validRoles = ['sysadmin','coordinator','programme_head','supervisor','viewer'];
  if (!validRoles.includes(role)) return res.json({ ok: false, error: 'Invalid role' });

  const sb = req.app.get('supabase');

  if (id) {
    // Update existing user
    const update = {
      username: username.trim(), role,
      full_name: fullName, email: email || '',
      active: active !== false,
      supervisor_id: supervisorId ? Number(supervisorId) : null
    };
    if (password) update.password_hash = await bcrypt.hash(password, 10);
    const { error } = await sb.from('users').update(update).eq('id', id);
    if (error) return res.json({ ok: false, error: error.message });
  } else {
    // New user
    if (!password) return res.json({ ok: false, error: 'Password required for new user' });
    const { data: existing } = await sb.from('users').select('id').ilike('username', username.trim()).limit(1);
    if (existing?.length) return res.json({ ok: false, error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const { error } = await sb.from('users').insert({
      username: username.trim(), password_hash: hash, role,
      full_name: fullName, email: email || '',
      active: true,
      supervisor_id: supervisorId ? Number(supervisorId) : null
    });
    if (error) return res.json({ ok: false, error: error.message });
  }
  return res.json({ ok: true });
});

// ── DELETE /api/auth/user/:id ────────────────────────────────────
// Replaces: deleteUser(id)
router.post('/delete-user', authMiddleware, requireRole('sysadmin'), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const sb = req.app.get('supabase');
  const { error } = await sb.from('users').delete().eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

module.exports = router;
