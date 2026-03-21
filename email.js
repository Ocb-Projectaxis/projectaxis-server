// ── routes/email.js ──────────────────────────────────────────────
// Deadline reminder emails — replaces sendDeadlineReminders(), sendReminderToStudent()
'use strict';
const router    = require('express').Router();
const nodemailer = require('nodemailer');
const { requireRole } = require('../middleware/auth');

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
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`{{${k}}}`, 'g'), v||'');
  }
  // Handle {{#supervisorName}}...{{/supervisorName}} conditionals
  out = out.replace(/\{\{#supervisorName\}\}([\s\S]*?)\{\{\/supervisorName\}\}/g,
    vars.supervisorName ? '$1' : '');
  return out;
}

// POST /api/email/remind-milestone   — Replaces: sendDeadlineReminders(milestoneId, dryRun)
router.post('/remind-milestone', requireRole('sysadmin','coordinator','programme_head'), async (req, res) => {
  const { milestoneId, dryRun } = req.body;
  const sb = req.app.get('supabase');

  const { data: settings } = await sb.from('settings').select('key, value');
  const cfg = {}; for (const s of (settings||[])) cfg[s.key] = s.value;

  const subjectTpl = cfg.emailSubject || '[{{institution}}] Reminder: {{milestoneName}} due {{dueDate}}';
  const bodyTpl    = cfg.emailBody    || 'Dear {{studentName}},\n\nReminder: {{milestoneName}} is due {{dueDate}}.\n\nBest regards,\n{{institution}}';
  const institution = cfg.institution || process.env.INSTITUTION || 'Your Institution';
  const adminEmail  = cfg.adminEmail  || process.env.SMTP_FROM;

  // Get milestones to remind
  let msQuery = sb.from('milestones').select('id, cohort_id, name, week_offset');
  if (milestoneId) msQuery = msQuery.eq('id', milestoneId);
  const { data: milestones } = await msQuery;

  const { data: students    } = await sb.from('students').select('id, cohort_id, name, email, supervisor_id');
  const { data: supervisors } = await sb.from('supervisors').select('id, name, email');
  const { data: progress    } = await sb.from('progress').select('student_id, milestone_id, done');
  const { data: cohorts     } = await sb.from('cohorts').select('id, name').eq('status','Active');

  const supMap     = {}; for (const s of (supervisors||[])) supMap[s.id] = s;
  const cohortMap  = {}; for (const c of (cohorts||[])) cohortMap[c.id] = c.name;
  const progressMap = {}; for (const p of (progress||[])) progressMap[`${p.student_id}_${p.milestone_id}`] = p.done;
  const activeCids = new Set((cohorts||[]).map(c => String(c.id)));

  const transport = dryRun ? null : makeTransport();
  let sent = 0, skipped = 0, errors = [];

  for (const ms of (milestones||[])) {
    if (!activeCids.has(String(ms.cohort_id))) continue;
    const cohortStudents = (students||[]).filter(s => String(s.cohort_id) === String(ms.cohort_id));

    for (const st of cohortStudents) {
      const done = progressMap[`${st.id}_${ms.id}`] || 0;
      if (done >= 2) { skipped++; continue; } // already approved
      if (!st.email) { skipped++; continue; }

      const sup = st.supervisor_id ? supMap[st.supervisor_id] : null;
      const vars = {
        studentName: st.name, milestoneName: ms.name,
        cohortName: cohortMap[ms.cohort_id] || '—',
        dueDate: ms.week_offset || 'TBD',
        status: done === 1 ? 'Submitted (awaiting approval)' : 'Not yet submitted',
        institution, supervisorName: sup?.name||'', supervisorEmail: sup?.email||''
      };

      if (!dryRun) {
        try {
          await transport.sendMail({
            from: `"${institution}" <${adminEmail}>`,
            to: st.email,
            subject: fillTemplate(subjectTpl, vars),
            text: fillTemplate(bodyTpl, vars)
          });
          sent++;
        } catch (e) {
          errors.push(`${st.name}: ${e.message}`);
        }
      } else {
        sent++;
      }
    }
  }

  return res.json({ ok: true, sent, skipped, errors, dryRun: !!dryRun });
});

// POST /api/email/remind-student   — Replaces: sendReminderToStudent(studentId, milestoneId)
router.post('/remind-student', requireRole('sysadmin','coordinator','programme_head'), async (req, res) => {
  const { studentId, milestoneId } = req.body;
  const sb = req.app.get('supabase');

  const [
    { data: student },
    { data: ms },
    { data: settings }
  ] = await Promise.all([
    sb.from('students').select('id, name, email, cohort_id, supervisor_id').eq('id', studentId).single(),
    sb.from('milestones').select('id, name, week_offset').eq('id', milestoneId).single(),
    sb.from('settings').select('key, value')
  ]);

  if (!student?.email) return res.json({ ok: false, error: 'Student has no email address' });

  const cfg = {}; for (const s of (settings||[])) cfg[s.key] = s.value;
  const { data: cohort     } = await sb.from('cohorts').select('name').eq('id', student.cohort_id).single();
  const { data: supervisor } = student.supervisor_id
    ? await sb.from('supervisors').select('name, email').eq('id', student.supervisor_id).single()
    : { data: null };

  const institution = cfg.institution || process.env.INSTITUTION;
  const vars = {
    studentName: student.name, milestoneName: ms?.name||'—',
    cohortName: cohort?.name||'—', dueDate: ms?.week_offset||'TBD',
    status: 'Pending', institution,
    supervisorName: supervisor?.name||'', supervisorEmail: supervisor?.email||''
  };

  try {
    const transport = makeTransport();
    await transport.sendMail({
      from: `"${institution}" <${cfg.adminEmail || process.env.SMTP_FROM}>`,
      to: student.email,
      subject: fillTemplate(cfg.emailSubject || '[{{institution}}] Reminder: {{milestoneName}} due {{dueDate}}', vars),
      text: fillTemplate(cfg.emailBody || 'Dear {{studentName}}, reminder for {{milestoneName}}.', vars)
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
