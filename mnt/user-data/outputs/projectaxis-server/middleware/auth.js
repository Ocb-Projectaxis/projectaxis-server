// ── middleware/auth.js ───────────────────────────────────────────
'use strict';
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // payload: { id, username, role, fullName, email, supervisorId }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Session expired — please log in again' });
  }
}

// Role-check helpers (mirror of HTML isSysAdmin() etc.)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'Access denied for your role' });
    }
    next();
  };
}

const isSysAdmin      = (user) => user?.role === 'sysadmin';
const isCoordinator   = (user) => user?.role === 'coordinator';
const isProgrammeHead = (user) => user?.role === 'programme_head';
const isSupervisor    = (user) => user?.role === 'supervisor';
const canEdit         = (user) => isSysAdmin(user) || isCoordinator(user);
const canManageUsers  = (user) => isSysAdmin(user);

module.exports = { authMiddleware, requireRole, isSysAdmin, isCoordinator,
                   isProgrammeHead, isSupervisor, canEdit, canManageUsers };
