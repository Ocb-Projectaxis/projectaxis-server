// ── routes/data.js ───────────────────────────────────────────────
// Read-only data fetching: getData, getProgressOnly, getChangeToken,
// getUpcomingDeadlines, getDataForSupervisor
'use strict';
const router = require('express').Router();
const { isSupervisor } = require('../middleware/auth');

// ── Helper: calculate student status from progress rows ──────────
function calcStatus(pct) {
  if (pct >= 100) return 'Completed';
  if (pct === 0)  return 'Delayed';
  if (pct < 30)   return 'At Risk';
  if (pct < 50)   return 'Delayed';
  return 'On Track';
}

// ── Helper: recalculate progress % and status for all students ───
// progress: array of { student_id, done }
// Returns map: studentId -> { pct, status }
function calcAllProgress(progressRows, milestonesByStudent) {
  const map = {};
  const totals = {};

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
    const tot = totals[sid] || 1;
    const pct = Math.round(data.points / tot * 100);
    result[sid] = { pct, status: calcStatus(pct) };
  }
  return result;
}

// ── Helper: map Supabase snake_case rows to frontend camelCase ───
function mapCohort(r)     { return { ID: String(r.id), Name: r.name, Semester: r.semester, Programme: r.programme, Unit: r.unit, StartDate: r.start_date||'', EndDate: r.end_date||'', Status: r.status, Level: r.level }; }
function mapStudent(r)    { return { ID: String(r.id), CohortID: String(r.cohort_id), Name: r.name, RegNo: r.reg_no, Email: r.email, SupervisorID: r.supervisor_id ? String(r.supervisor_id) : '', Title: r.title, StartDate: r.start_date||'', EndDate: r.end_date||'', Status: r.status, Progress: r.progress, Mobile: r.mobile, Programme: r.programme, Specialisation: r.specialisation }; }
function mapMilestone(r)  { return { ID: String(r.id), CohortID: String(r.cohort_id), Order: r.order, Name: r.name, WeekOffset: r.week_offset||'' }; }
function mapProgress(r)   { return { StudentID: String(r.student_id), MilestoneID: String(r.milestone_id), Done: r.done, Date: r.date||'', UpdatedBy: r.updated_by }; }
function mapLog(r)        { return { ID: String(r.id), StudentID: String(r.student_id), CohortID: String(r.cohort_id), Date: r.date||'', Note: r.note, By: r.by, Type: r.type }; }
function mapSession(r)    { return { ID: String(r.id), StudentID: String(r.student_id), MilestoneID: r.milestone_id ? String(r.milestone_id) : '', SessionDate: r.session_date||'', Attended: r.attended, Notes: r.notes, RecordedBy: r.recorded_by }; }
function mapSupervisor(r) { return { ID: String(r.id), Name: r.name, Email: r.email, Department: r.department }; }
function mapProgramme(r)  { return { ID: String(r.id), Name: r.name, Code: r.code, Units: r.units }; }

// ── GET /api/data/boot ───────────────────────────────────────────
// Replaces: bootData() — all data in one call
router.get('/boot', async (req, res) => {
  const sb = req.app.get('supabase');
  try {
    const [
      { data: cohorts },
      { data: students },
      { data: milestones },
      { data: progress },
      { data: logs },
      { data: sessions },
      { data: supervisors },
      { data: programmes },
      { data: settings }
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

    // Recalculate all student status/progress from progress rows
    // This is the client-side recalcAllStudents() logic, now done server-side
    const progCalc = calcAllProgress(progress || []);
    const mappedStudents = (students || []).map(s => {
      const calc = progCalc[String(s.id)];
      return {
        ...mapStudent(s),
        Progress: calc ? calc.pct : s.progress,
        Status:   calc ? calc.status : s.status
      };
    });

    // Settings as object
    const settingsObj = {};
    for (const row of (settings || [])) settingsObj[row.key] = row.value;

    // Change token
    const doneSum = (progress||[]).reduce((a, p) => a + p.done, 0);
    const token   = `${(progress||[]).length}_${(students||[]).length}_${(cohorts||[]).length}_${doneSum}`;

    return res.json({
      ok: true,
      ping: 'WORKS',
      token,
      cohorts:     (cohorts     || []).map(mapCohort),
      students:    mappedStudents,
      milestones:  (milestones  || []).map(mapMilestone),
      progress:    (progress    || []).map(mapProgress),
      logs:        (logs        || []).map(mapLog),
      sessions:    (sessions    || []).map(mapSession),
      supervisors: (supervisors || []).map(mapSupervisor),
      programmes:  (programmes  || []).map(mapProgramme),
      settings:    settingsObj
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/data/boot-supervisor ────────────────────────────────
// Replaces: getDataForSupervisor(supervisorId)
router.get('/boot-supervisor', async (req, res) => {
  const supId = req.user.supervisorId ? Number(req.user.supervisorId) : null;
  if (!supId) return res.json({ ok: false, error: 'No Supervisor ID linked to your account. Ask your admin.' });

  const sb = req.app.get('supabase');
  try {
    // Only students assigned to this supervisor
    const { data: myStudents } = await sb.from('students').select('*').eq('supervisor_id', supId).order('id');
    const studentIds = (myStudents || []).map(s => s.id);

    const [
      { data: cohorts },
      { data: milestones },
      { data: progress },
      { data: logs },
      { data: sessions },
      { data: supervisors },
      { data: programmes },
      { data: settings }
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
    const mappedStudents = (myStudents || []).map(s => {
      const calc = progCalc[String(s.id)];
      return { ...mapStudent(s), Progress: calc ? calc.pct : s.progress, Status: calc ? calc.status : s.status };
    });

    const settingsObj = {};
    for (const row of (settings || [])) settingsObj[row.key] = row.value;

    const doneSum = (progress||[]).reduce((a,p) => a + p.done, 0);
    const token   = `${(progress||[]).length}_${(myStudents||[]).length}_${(cohorts||[]).length}_${doneSum}`;

    return res.json({
      ok: true, token,
      cohorts:     (cohorts     || []).map(mapCohort),
      students:    mappedStudents,
      milestones:  (milestones  || []).map(mapMilestone),
      progress:    (progress    || []).map(mapProgress),
      logs:        (logs        || []).map(mapLog),
      sessions:    (sessions    || []).map(mapSession),
      supervisors: (supervisors || []).map(mapSupervisor),
      programmes:  (programmes  || []).map(mapProgramme),
      settings:    settingsObj
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/data/progress-only ──────────────────────────────────
// Replaces: getProgressOnly() — fast poll endpoint
router.get('/progress-only', async (req, res) => {
  const sb = req.app.get('supabase');
  try {
    let progressQuery = sb.from('progress').select('student_id, milestone_id, done, date, updated_by');
    let studentsQuery = sb.from('students').select('id, cohort_id, name, reg_no, email, supervisor_id, title, start_date, end_date, status, progress, mobile, programme, specialisation');

    // Supervisor filter
    if (isSupervisor(req.user) && req.user.supervisorId) {
      const { data: myIds } = await sb.from('students').select('id').eq('supervisor_id', Number(req.user.supervisorId));
      const ids = (myIds||[]).map(s => s.id);
      if (ids.length) {
        progressQuery = progressQuery.in('student_id', ids);
        studentsQuery = studentsQuery.in('id', ids);
      }
    }

    const [{ data: progress }, { data: students }] = await Promise.all([progressQuery, studentsQuery]);

    const progCalc = calcAllProgress(progress || []);
    const mappedStudents = (students || []).map(s => {
      const calc = progCalc[String(s.id)];
      return { ...mapStudent(s), Progress: calc ? calc.pct : s.progress, Status: calc ? calc.status : s.status };
    });

    const doneSum = (progress||[]).reduce((a,p) => a + p.done, 0);
    const token   = `${(progress||[]).length}_${(students||[]).length}_${doneSum}`;

    return res.json({ ok: true, token, progress: (progress||[]).map(mapProgress), students: mappedStudents });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/data/change-token ───────────────────────────────────
// Replaces: getChangeToken() — ultra-lightweight poll check
router.get('/change-token', async (req, res) => {
  const sb = req.app.get('supabase');
  try {
    const [
      { count: prCount },
      { count: stCount },
      { count: coCount },
      { count: msCount },
      { count: lgCount }
    ] = await Promise.all([
      sb.from('progress').select('id', { count: 'exact', head: true }),
      sb.from('students').select('id', { count: 'exact', head: true }),
      sb.from('cohorts').select('id', { count: 'exact', head: true }),
      sb.from('milestones').select('id', { count: 'exact', head: true }),
      sb.from('logs').select('id', { count: 'exact', head: true })
    ]);
    // Also get done sum for fine-grained milestone change detection
    const { data: done } = await sb.from('progress').select('done');
    const doneSum = (done||[]).reduce((a,p) => a + p.done, 0);
    const token = `${prCount}_${stCount}_${coCount}_${msCount}_${lgCount}_${doneSum}`;
    return res.json({ ok: true, token });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/data/deadlines ──────────────────────────────────────
// Replaces: getUpcomingDeadlines()
router.get('/deadlines', async (req, res) => {
  const sb  = req.app.get('supabase');
  const { data: settings } = await sb.from('settings').select('key, value');
  const cfg = {};
  for (const s of (settings||[])) cfg[s.key] = s.value;
  const warnDays = parseInt(cfg.deadlineWarnDays || '14', 10);

  const today    = new Date(); today.setHours(0,0,0,0);
  const warnDate = new Date(today); warnDate.setDate(warnDate.getDate() + warnDays);

  try {
    const { data: milestones } = await sb.from('milestones').select('id, cohort_id, name, week_offset').not('week_offset', 'is', null);
    const { data: cohorts    } = await sb.from('cohorts').select('id, name').eq('status','Active');
    const { data: students   } = await sb.from('students').select('id, cohort_id, supervisor_id');
    const { data: progress   } = await sb.from('progress').select('student_id, milestone_id, done');

    const cohortMap = {}; for (const c of (cohorts||[])) cohortMap[c.id] = c.name;
    const progressMap = {}; for (const p of (progress||[])) progressMap[`${p.student_id}_${p.milestone_id}`] = p.done;

    const activeCoIds = new Set((cohorts||[]).map(c => String(c.id)));

    const alerts = [];
    for (const ms of (milestones||[])) {
      if (!activeCoIds.has(String(ms.cohort_id))) continue;
      if (!ms.week_offset) continue;
      const dueDate = new Date(ms.week_offset); dueDate.setHours(0,0,0,0);
      if (dueDate > warnDate) continue; // not yet in warning window

      const cohortStudents = (students||[]).filter(s => String(s.cohort_id) === String(ms.cohort_id));
      const pendingStudents = cohortStudents.filter(s => {
        const done = progressMap[`${s.id}_${ms.id}`] || 0;
        return done < 2; // not approved
      });

      if (!pendingStudents.length) continue;

      alerts.push({
        milestoneId:   String(ms.id),
        milestoneName: ms.name,
        cohortId:      String(ms.cohort_id),
        cohortName:    cohortMap[ms.cohort_id] || '—',
        dueDate:       ms.week_offset,
        daysUntilDue:  Math.round((dueDate - today) / 86400000),
        pendingCount:  pendingStudents.length
      });
    }

    alerts.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
    return res.json({ ok: true, alerts, warnDays });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
