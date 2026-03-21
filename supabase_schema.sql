-- ═══════════════════════════════════════════════════════════════════
-- ProjectAxis — Supabase Database Schema
-- Run this in your Supabase SQL editor (Dashboard → SQL Editor → New query)
-- Run sections in order: tables first, then indexes, then RLS policies.
-- ═══════════════════════════════════════════════════════════════════

-- ── Enable UUID extension ────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── Drop existing tables (clean install only — skip if migrating) ─
-- drop table if exists progress, logs, sessions, milestones, students,
--   cohorts, supervisors, programmes, users, settings cascade;

-- ────────────────────────────────────────────────────────────────
-- SETTINGS
-- ────────────────────────────────────────────────────────────────
create table if not exists settings (
  key   text primary key,
  value text not null default ''
);

insert into settings (key, value) values
  ('systemName',       'ProjectAxis'),
  ('institution',      'Oxford College of Business'),
  ('adminEmail',       ''),
  ('deadlineWarnDays', '14'),
  ('pollInterval',     '15'),
  ('emailSubject',     '[{{institution}}] Reminder: {{milestoneName}} due {{dueDate}}'),
  ('emailBody',        'Dear {{studentName}},\n\nThis is a reminder regarding your project milestone.\n\nMilestone: {{milestoneName}}\nDue date: {{dueDate}}\nCohort: {{cohortName}}\n\nBest regards,\n{{institution}}')
on conflict (key) do nothing;

-- ────────────────────────────────────────────────────────────────
-- USERS  (custom auth — not Supabase Auth)
-- Roles: sysadmin | coordinator | programme_head | supervisor | viewer
-- ────────────────────────────────────────────────────────────────
create table if not exists users (
  id            serial primary key,
  username      text not null unique,
  password_hash text not null,
  role          text not null check (role in ('sysadmin','coordinator','programme_head','supervisor','viewer')),
  full_name     text not null,
  email         text not null default '',
  last_login    timestamptz,
  active        boolean not null default true,
  supervisor_id integer,  -- FK added after supervisors table
  created_at    timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────
-- SUPERVISORS
-- ────────────────────────────────────────────────────────────────
create table if not exists supervisors (
  id         serial primary key,
  name       text not null,
  email      text not null default '',
  department text not null default '',
  created_at timestamptz not null default now()
);

-- Add FK from users to supervisors
alter table users
  add constraint fk_users_supervisor
  foreign key (supervisor_id) references supervisors(id)
  on delete set null;

-- ────────────────────────────────────────────────────────────────
-- PROGRAMMES
-- ────────────────────────────────────────────────────────────────
create table if not exists programmes (
  id         serial primary key,
  name       text not null,
  code       text not null default '',
  units      text not null default '',  -- comma-separated unit names
  created_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────
-- COHORTS
-- ────────────────────────────────────────────────────────────────
create table if not exists cohorts (
  id          serial primary key,
  name        text not null,
  semester    text not null default '',
  programme   text not null default '',
  unit        text not null default '',
  start_date  date,
  end_date    date,
  status      text not null default 'Active' check (status in ('Active','Closed')),
  level       text not null default 'PG' check (level in ('PG','UG')),
  created_at  timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────
-- STUDENTS
-- ────────────────────────────────────────────────────────────────
create table if not exists students (
  id              serial primary key,
  cohort_id       integer not null references cohorts(id) on delete cascade,
  name            text not null,
  reg_no          text not null unique,
  email           text not null default '',
  supervisor_id   integer references supervisors(id) on delete set null,
  title           text not null default '',
  start_date      date,
  end_date        date,
  status          text not null default 'Delayed'
                    check (status in ('On Track','Delayed','At Risk','Completed')),
  progress        integer not null default 0 check (progress >= 0 and progress <= 100),
  mobile          text not null default '',
  programme       text not null default '',
  specialisation  text not null default '',
  created_at      timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────
-- MILESTONES
-- ────────────────────────────────────────────────────────────────
create table if not exists milestones (
  id          serial primary key,
  cohort_id   integer not null references cohorts(id) on delete cascade,
  "order"     integer not null default 1,
  name        text not null,
  week_offset date,  -- actual deadline date (named week_offset for backward compat)
  created_at  timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────
-- PROGRESS  (milestone completion per student)
-- done: 0=Pending, 1=Submitted, 2=Approved
-- ────────────────────────────────────────────────────────────────
create table if not exists progress (
  id           serial primary key,
  student_id   integer not null references students(id) on delete cascade,
  milestone_id integer not null references milestones(id) on delete cascade,
  done         smallint not null default 0 check (done in (0,1,2)),
  date         date,
  updated_by   text not null default '',
  created_at   timestamptz not null default now(),
  unique (student_id, milestone_id)
);

-- ────────────────────────────────────────────────────────────────
-- LOGS
-- ────────────────────────────────────────────────────────────────
create table if not exists logs (
  id         serial primary key,
  student_id integer not null references students(id) on delete cascade,
  cohort_id  integer not null references cohorts(id) on delete cascade,
  date       date not null default current_date,
  note       text not null default '',
  by         text not null default '',
  type       text not null default 'Update'
               check (type in ('Update','Alert','Concern','Approval','Meeting')),
  created_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────
-- SESSIONS  (1-on-1 sessions)
-- attended: 1=Attended, 2=Rescheduled, 3=Booked, 0=Absent
-- ────────────────────────────────────────────────────────────────
create table if not exists sessions (
  id            serial primary key,
  student_id    integer not null references students(id) on delete cascade,
  milestone_id  integer references milestones(id) on delete set null,
  session_date  date,
  attended      smallint not null default 3 check (attended in (0,1,2,3)),
  notes         text not null default '',
  recorded_by   text not null default '',
  created_at    timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════
-- INDEXES  (speeds up common queries)
-- ════════════════════════════════════════════════════════════════
create index if not exists idx_students_cohort    on students(cohort_id);
create index if not exists idx_students_supervisor on students(supervisor_id);
create index if not exists idx_milestones_cohort  on milestones(cohort_id);
create index if not exists idx_progress_student   on progress(student_id);
create index if not exists idx_progress_milestone on progress(milestone_id);
create index if not exists idx_logs_student       on logs(student_id);
create index if not exists idx_sessions_student   on sessions(student_id);

-- ════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY  (disable — server uses service role key)
-- The Node.js server authenticates users and enforces roles itself.
-- Supabase RLS is turned off so the service role key has full access.
-- ════════════════════════════════════════════════════════════════
alter table settings    disable row level security;
alter table users       disable row level security;
alter table supervisors disable row level security;
alter table programmes  disable row level security;
alter table cohorts     disable row level security;
alter table students    disable row level security;
alter table milestones  disable row level security;
alter table progress    disable row level security;
alter table logs        disable row level security;
alter table sessions    disable row level security;

-- ════════════════════════════════════════════════════════════════
-- SEED: Default admin user (password: admin123 — change immediately!)
-- bcrypt hash of 'admin123' with 10 rounds
-- ════════════════════════════════════════════════════════════════
insert into users (username, password_hash, role, full_name, email, active)
values (
  'admin',
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',  -- admin123
  'sysadmin',
  'System Administrator',
  '',
  true
) on conflict (username) do nothing;

-- Seed sample supervisors
insert into supervisors (name, email, department) values
  ('Dr. Silva',   'silva@ocb.edu',   'Computer Science'),
  ('Prof. James', 'james@ocb.edu',   'Engineering'),
  ('Dr. Patel',   'patel@ocb.edu',   'Data Science'),
  ('Dr. Nguyen',  'nguyen@ocb.edu',  'Mathematics')
on conflict do nothing;

-- Seed sample programmes
insert into programmes (name, code, units) values
  ('Master of Computer Science',        'MCS',  'Research Methods,Advanced Software Eng,Capstone Project'),
  ('Master of Business Administration', 'MBA',  'Business Research,Strategic Management'),
  ('Master of Data Science',            'MDS',  'Data Capstone,Machine Learning Project'),
  ('Master of Engineering',             'MEng', 'Engineering Design Project')
on conflict do nothing;
