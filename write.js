// ── routes/write.js ──────────────────────────────────────────────
// All write operations: cohorts, students, milestones, progress,
// logs, sessions, supervisors, programmes, settings
'use strict';
const router = require('express').Router();
const { requireRole, canEdit } = require('../middleware/auth');

// ── Helper: recalculate and persist student status/progress ──────
async function recalcStudent(sb, studentId) {
  const { data: rows } = await sb.from('progress')
    .select('done').eq('student_id', studentId);
  if (!rows || !rows.length) {
    await sb.from('students').update({ status: 'Delayed', progress: 0 }).eq('id', studentId);
    return { pct: 0, status: 'Delayed' };
  }
  const total  = rows.length;
  const points = rows.reduce((acc, r) => acc + (r.done === 2 ? 1 : r.done === 1 ? 0.5 : 0), 0);
  const pct    = Math.round(points / total * 100);
  const status = pct >= 100 ? 'Completed' : pct === 0 ? 'Delayed' : pct < 30 ? 'At Risk' : pct < 50 ? 'Delayed' : 'On Track';
  await sb.from('students').update({ status, progress: pct }).eq('id', studentId);
  return { pct, status };
}

// ════════════════════════════════════════════════════════════════
// COHORTS
// ════════════════════════════════════════════════════════════════

// POST /api/write/cohort/add   — Replaces: addCohort()
router.post('/cohort/add', requireRole('sysadmin','coordinator'), async (req, res) => {
  const { name, semester, programme, unit, startDate, endDate, level } = req.body;
  if (!name || !semester) return res.json({ ok: false, error: 'Name and semester required' });
  const sb = req.app.get('supabase');

  const { data: cohort, error: ce } = await sb.from('cohorts').insert({
    name, semester, programme: programme||'', unit: unit||'',
    start_date: startDate||null, end_date: endDate||null,
    status: 'Active', level: level||'PG'
  }).select().single();
  if (ce) return res.json({ ok: false, error: ce.message });

  // Add default milestones
  const defaultMilestones = ['Proposal','Literature Review','Methodology','Data Collection','Analysis','Draft','Final Submission'];
  await sb.from('milestones').insert(
    defaultMilestones.map((name, i) => ({ cohort_id: cohort.id, order: i+1, name }))
  );
  return res.json({ ok: true, id: String(cohort.id) });
});

// POST /api/write/cohort/update   — Replaces: updateCohort()
router.post('/cohort/update', requireRole('sysadmin','coordinator'), async (req, res) => {
  const { id, name, semester, programme, unit, startDate, endDate, status, level } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const sb = req.app.get('supabase');
  const { error } = await sb.from('cohorts').update({
    name, semester, programme: programme||'', unit: unit||'',
    start_date: startDate||null, end_date: endDate||null,
    status, level: level||'PG'
  }).eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// POST /api/write/cohort/delete   — Replaces: deleteCohort()
router.post('/cohort/delete', requireRole('sysadmin'), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const sb = req.app.get('supabase');
  // ON DELETE CASCADE handles students, milestones, progress, logs
  const { error } = await sb.from('cohorts').delete().eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// STUDENTS
// ════════════════════════════════════════════════════════════════

// POST /api/write/student/add   — Replaces: addStudent()
router.post('/student/add', requireRole('sysadmin','coordinator'), async (req, res) => {
  const { cohortId, name, regNo, email, supervisorId, title, mobile, programme, specialisation } = req.body;
  if (!cohortId || !name || !regNo) return res.json({ ok: false, error: 'cohortId, name, regNo required' });
  const sb = req.app.get('supabase');

  // Get cohort dates
  const { data: cohort } = await sb.from('cohorts').select('start_date, end_date').eq('id', cohortId).single();

  const { data: student, error: se } = await sb.from('students').insert({
    cohort_id: Number(cohortId), name, reg_no: regNo, email: email||'',
    supervisor_id: supervisorId ? Number(supervisorId) : null,
    title: title||'', mobile: mobile||'', programme: programme||'', specialisation: specialisation||'',
    start_date: cohort?.start_date||null, end_date: cohort?.end_date||null,
    status: 'Delayed', progress: 0
  }).select().single();
  if (se) return res.json({ ok: false, error: se.message });

  // Link to existing milestones
  const { data: milestones } = await sb.from('milestones').select('id').eq('cohort_id', cohortId);
  if (milestones?.length) {
    await sb.from('progress').insert(
      milestones.map(m => ({ student_id: student.id, milestone_id: m.id, done: 0, updated_by: '' }))
    );
  }
  return res.json({ ok: true, id: String(student.id) });
});

// POST /api/write/student/update   — Replaces: updateStudent()
router.post('/student/update', requireRole('sysadmin','coordinator'), async (req, res) => {
  const { id, name, regNo, email, title, cohortId, supervisorId, mobile, programme, specialisation } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const sb = req.app.get('supabase');
  const { error } = await sb.from('students').update({
    name, reg_no: regNo, email: email||'', title: title||'',
    cohort_id: Number(cohortId),
    supervisor_id: supervisorId ? Number(supervisorId) : null,
    mobile: mobile||'', programme: programme||'', specialisation: specialisation||''
  }).eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// POST /api/write/student/update-status   — Replaces: updateStudentStatus()
router.post('/student/update-status', requireRole('sysadmin'), async (req, res) => {
  const { id, status, progressPct } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const sb = req.app.get('supabase');
  const update = { status };
  if (progressPct !== null && progressPct !== undefined) update.progress = Number(progressPct);
  const { error } = await sb.from('students').update(update).eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// POST /api/write/student/bulk-add   — Replaces: bulkAdd()
router.post('/student/bulk-add', requireRole('sysadmin','coordinator'), async (req, res) => {
  const { cohortId, rows } = req.body;
  if (!cohortId || !rows?.length) return res.json({ ok: false, error: 'cohortId and rows required' });
  const sb = req.app.get('supabase');

  const { data: cohort } = await sb.from('cohorts').select('start_date, end_date').eq('id', cohortId).single();
  const { data: milestones } = await sb.from('milestones').select('id').eq('cohort_id', cohortId);
  const { data: existing } = await sb.from('students').select('reg_no');
  const existingRegNos = new Set((existing||[]).map(s => s.reg_no.toLowerCase()));

  let added = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.name || !r.regNo) { errors.push(`Row ${i+1}: name/regNo missing`); continue; }
    const key = r.regNo.trim().toLowerCase();
    if (existingRegNos.has(key)) { errors.push(`Row ${i+1}: RegNo ${r.regNo} already exists`); skipped++; continue; }

    const { data: student, error: se } = await sb.from('students').insert({
      cohort_id: Number(cohortId), name: r.name, reg_no: r.regNo, email: r.email||'',
      supervisor_id: r.supervisorId ? Number(r.supervisorId) : null,
      title: r.title||'', mobile: r.mobile||'', programme: r.programme||'', specialisation: r.specialisation||'',
      start_date: cohort?.start_date||null, end_date: cohort?.end_date||null,
      status: 'Delayed', progress: 0
    }).select().single();

    if (se) { errors.push(`Row ${i+1}: ${se.message}`); continue; }
    if (milestones?.length) {
      await sb.from('progress').insert(milestones.map(m => ({ student_id: student.id, milestone_id: m.id, done: 0, updated_by: '' })));
    }
    existingRegNos.add(key);
    added++;
  }
  return res.json({ ok: true, added, skipped, errors });
});

// ════════════════════════════════════════════════════════════════
// MILESTONES
// ════════════════════════════════════════════════════════════════

// POST /api/write/milestones/save   — Replaces: saveMilestones()
router.post('/milestones/save', requireRole('sysadmin','coordinator'), async (req, res) => {
  const { cohortId, milestones } = req.body;
  if (!cohortId || !milestones?.length) return res.json({ ok: false, error: 'cohortId and milestones required' });
  const sb = req.app.get('supabase');

  // Get existing milestone IDs for this cohort (to clean up progress rows for removed ones)
  const { data: oldMs } = await sb.from('milestones').select('id').eq('cohort_id', cohortId);
  const oldIds = (oldMs||[]).map(m => m.id);

  // Delete all existing milestones for this cohort (progress rows cascade)
  if (oldIds.length) await sb.from('milestones').delete().in('id', oldIds);

  // Insert new milestones and re-link progress rows
  const { data: inserted } = await sb.from('milestones').insert(
    milestones.map((m, i) => ({ cohort_id: Number(cohortId), order: i+1, name: m.name, week_offset: m.weekOffset||null }))
  ).select();

  // Re-create progress rows for all students in cohort
  const { data: students } = await sb.from('students').select('id').eq('cohort_id', cohortId);
  if (students?.length && inserted?.length) {
    const progressRows = [];
    for (const s of students) {
      for (const m of inserted) {
        progressRows.push({ student_id: s.id, milestone_id: m.id, done: 0, updated_by: '' });
      }
    }
    await sb.from('progress').insert(progressRows);
  }
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// PROGRESS TICKS
// ════════════════════════════════════════════════════════════════

// POST /api/write/tick   — Replaces: saveTick()
router.post('/tick', async (req, res) => {
  const { studentId, milestoneId, doneVal, updatedBy } = req.body;
  const dv = Number(doneVal);
  if (!studentId || !milestoneId) return res.json({ ok: false, error: 'studentId and milestoneId required' });
  const sb = req.app.get('supabase');

  const { error } = await sb.from('progress').upsert(
    { student_id: Number(studentId), milestone_id: Number(milestoneId), done: dv,
      date: dv > 0 ? new Date().toISOString().slice(0,10) : null,
      updated_by: updatedBy || '' },
    { onConflict: 'student_id,milestone_id' }
  );
  if (error) return res.json({ ok: false, error: error.message });

  // Recalculate student status
  const calc = await recalcStudent(sb, Number(studentId));
  return res.json({ ok: true, progress: calc.pct, status: calc.status });
});

// ════════════════════════════════════════════════════════════════
// LOGS
// ════════════════════════════════════════════════════════════════

// POST /api/write/log/add   — Replaces: addLog()
router.post('/log/add', requireRole('sysadmin','coordinator','programme_head'), async (req, res) => {
  const { studentId, cohortId, note, by, type } = req.body;
  if (!studentId || !cohortId || !note) return res.json({ ok: false, error: 'studentId, cohortId, note required' });
  const sb = req.app.get('supabase');
  const { error } = await sb.from('logs').insert({
    student_id: Number(studentId), cohort_id: Number(cohortId),
    date: new Date().toISOString().slice(0,10),
    note, by: by||'Admin', type: type||'Update'
  });
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// POST /api/write/log/delete   — Replaces: deleteLog()
router.post('/log/delete', requireRole('sysadmin'), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ ok: false, error: 'id required' });
  const sb = req.app.get('supabase');
  const { error } = await sb.from('logs').delete().eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// SESSIONS
// ════════════════════════════════════════════════════════════════

// POST /api/write/session/save   — Replaces: saveSession()
router.post('/session/save', async (req, res) => {
  const { id, studentId, milestoneId, sessionDate, attended, notes, recordedBy } = req.body;
  if (!studentId) return res.json({ ok: false, error: 'studentId required' });
  const sb = req.app.get('supabase');
  const data = {
    student_id: Number(studentId),
    milestone_id: milestoneId ? Number(milestoneId) : null,
    session_date: sessionDate||null, attended: Number(attended)||3,
    notes: notes||'', recorded_by: recordedBy||''
  };
  const { error } = id
    ? await sb.from('sessions').update(data).eq('id', id)
    : await sb.from('sessions').insert(data);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// POST /api/write/session/delete   — Replaces: deleteSession()
router.post('/session/delete', async (req, res) => {
  const { id } = req.body;
  const sb = req.app.get('supabase');
  const { error } = await sb.from('sessions').delete().eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// SUPERVISORS
// ════════════════════════════════════════════════════════════════

// POST /api/write/supervisor/save   — Replaces: saveSupervisor()
router.post('/supervisor/save', requireRole('sysadmin','coordinator'), async (req, res) => {
  const { id, name, email, department } = req.body;
  if (!name) return res.json({ ok: false, error: 'name required' });
  const sb = req.app.get('supabase');
  const data = { name, email: email||'', department: department||'' };
  const { error } = id
    ? await sb.from('supervisors').update(data).eq('id', id)
    : await sb.from('supervisors').insert(data);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// POST /api/write/supervisor/delete   — Replaces: deleteSupervisor()
router.post('/supervisor/delete', requireRole('sysadmin'), async (req, res) => {
  const { id } = req.body;
  const sb = req.app.get('supabase');
  const { error } = await sb.from('supervisors').delete().eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// PROGRAMMES
// ════════════════════════════════════════════════════════════════

// POST /api/write/programme/save   — Replaces: saveProgramme()
router.post('/programme/save', requireRole('sysadmin','coordinator'), async (req, res) => {
  const { id, name, code, units } = req.body;
  if (!name) return res.json({ ok: false, error: 'name required' });
  const sb = req.app.get('supabase');
  const data = { name, code: code||'', units: units||'' };
  const { error } = id
    ? await sb.from('programmes').update(data).eq('id', id)
    : await sb.from('programmes').insert(data);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// POST /api/write/programme/delete   — Replaces: deleteProgramme()
router.post('/programme/delete', requireRole('sysadmin'), async (req, res) => {
  const { id } = req.body;
  const sb = req.app.get('supabase');
  const { error } = await sb.from('programmes').delete().eq('id', id);
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════

// POST /api/write/settings   — Replaces: saveSettings()
router.post('/settings', requireRole('sysadmin'), async (req, res) => {
  const settings = req.body; // { key: value, ... }
  if (!settings || typeof settings !== 'object') return res.json({ ok: false, error: 'settings object required' });
  const sb = req.app.get('supabase');
  const rows = Object.entries(settings).map(([key, value]) => ({ key, value: String(value) }));
  const { error } = await sb.from('settings').upsert(rows, { onConflict: 'key' });
  if (error) return res.json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

module.exports = router;
