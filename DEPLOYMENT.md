# ProjectAxis — Supabase Migration Guide
## From Google Apps Script → Node.js + Supabase

---

## What changes

| Before (GAS) | After (Supabase) |
|---|---|
| Google Sheets = database | PostgreSQL on Supabase |
| Code.gs = backend | server.js on Railway |
| `gsr().funcName()` = API call | `fetch('/api/...')` via JWT |
| Polling every 15s for changes | Real-time WebSocket (optional, Phase 2) |
| ~3-8s cold start per call | ~50-200ms per call |
| 100KB cache limit | No limit |
| Save race conditions | Atomic DB transactions |

**Your HTML frontend is almost unchanged.** The `gsr()` function now acts as
a proxy that calls your Railway API instead of Google Apps Script. All 46 call
sites work without modification.

---

## Step 1 — Create your Supabase project (5 minutes)

1. Go to **https://supabase.com** → Sign in with GitHub → New project
2. Choose a name: `projectaxis`
3. Choose a region closest to Sri Lanka: **Singapore (ap-southeast-1)**
4. Set a strong database password (save it somewhere safe)
5. Wait ~2 minutes for the project to provision

**Get your credentials:**
- Dashboard → Settings → API
- Copy **Project URL** (looks like `https://abcdefgh.supabase.co`)
- Copy **service_role** key (the long one — NOT the anon key)

---

## Step 2 — Create the database schema (3 minutes)

1. Dashboard → **SQL Editor** → New query
2. Open `supabase_schema.sql` from this package
3. Paste the entire file → **Run**
4. You should see: "Success. No rows returned"

This creates all 10 tables with the correct structure and seeds:
- Default admin user (admin / admin123) — **change this password immediately**
- Sample supervisors and programmes

---

## Step 3 — Migrate your existing Google Sheets data (10-30 minutes)

Run these exports from your Google Sheets, then import to Supabase.

### Option A — Automatic migration script (recommended)

Open your Google Apps Script editor and run this function:

```javascript
function exportForSupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ['Cohorts','Students','Milestones','Progress','Logs',
                'Sessions','Supervisors','Programmes'];
  var out = {};
  sheets.forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) { out[name] = []; return; }
    var data = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    var hdrs = data[0];
    out[name] = data.slice(1).map(function(row) {
      var obj = {};
      hdrs.forEach(function(h, i) { obj[h] = row[i]; });
      return obj;
    });
  });
  // Log as JSON — copy from logs panel
  Logger.log(JSON.stringify(out));
  // Or write to a Drive file:
  DriveApp.createFile('projectaxis_export.json',
    JSON.stringify(out, null, 2), MimeType.PLAIN_TEXT);
  SpreadsheetApp.getUi().alert('Exported! Check your Drive root for projectaxis_export.json');
}
```

Then use the Supabase Table Editor (Dashboard → Table Editor) to import
each sheet's data, or use the REST API.

### Option B — Manual via Supabase Table Editor

For each table: Dashboard → Table Editor → select table → Insert → 
paste rows from your Google Sheet.

### Column name mapping (Google Sheets → Supabase)

| Sheet column | Supabase column |
|---|---|
| ID | id |
| CohortID | cohort_id |
| SupervisorID | supervisor_id |
| MilestoneID | milestone_id |
| StudentID | student_id |
| RegNo | reg_no |
| StartDate | start_date |
| EndDate | end_date |
| WeekOffset | week_offset |
| UpdatedBy | updated_by |
| SessionDate | session_date |
| RecordedBy | recorded_by |
| PasswordHash | password_hash |
| FullName | full_name |
| LastLogin | last_login |
| SupervisorID (Users) | supervisor_id |

---

## Step 4 — Deploy the Node.js server to Railway (5 minutes)

### First time setup

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# In the projectaxis-server folder:
cd projectaxis-server
railway init         # creates a new project
railway up           # deploys
```

### Add environment variables

Railway Dashboard → your project → Variables → Add all from `.env.example`:

```
SUPABASE_URL          = https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY = eyJ...your-service-role-key...
JWT_SECRET            = (run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
FRONTEND_URL          = * (or your exact domain once you have one)
PORT                  = 3000
SMTP_HOST             = smtp.gmail.com
SMTP_PORT             = 587
SMTP_USER             = your-gmail@gmail.com
SMTP_PASS             = your-gmail-app-password
INSTITUTION           = Oxford College of Business
```

**Gmail App Password:** Google Account → Security → 2-Step Verification →
App passwords → Create one for "Mail" → copy the 16-char code.

### Get your Railway URL

Railway Dashboard → your project → Settings → Domains → Generate Domain
It will look like: `https://projectaxis-server-production.up.railway.app`

---

## Step 5 — Configure the frontend HTML (2 minutes)

Open `ProjectAxis_Supabase_index.html` and find line ~761:

```javascript
var API_BASE = (window.PROJECTAXIS_API_URL || 'https://your-app.railway.app');
```

Replace `https://your-app.railway.app` with your actual Railway URL:

```javascript
var API_BASE = (window.PROJECTAXIS_API_URL || 'https://projectaxis-server-production.up.railway.app');
```

Save the file.

---

## Step 6 — Host the frontend HTML (3 minutes)

The HTML is a single file — host it anywhere:

### Option A — Netlify Drop (free, instant, no account needed)
1. Go to **https://app.netlify.com/drop**
2. Drag `ProjectAxis_Supabase_index.html` onto the page
3. Rename the file to `index.html` first
4. You get a URL like `https://random-name.netlify.app`

### Option B — GitHub Pages (free, custom domain support)
1. Create a new GitHub repo
2. Add `index.html` (renamed from `ProjectAxis_Supabase_index.html`)
3. Settings → Pages → Deploy from branch → main
4. Your URL: `https://yourusername.github.io/projectaxis`

### Option C — Railway static site
Add the HTML to your server repo and serve it with Express:
```javascript
// In server.js, add before routes:
app.use(express.static('public'));
// Put index.html in a /public folder
```

---

## Step 7 — Test everything

1. Open your frontend URL
2. Log in: `admin` / `admin123`
3. **Change the admin password immediately** (Settings → My Account → Change Password)
4. Create a test cohort → add a student → tick a milestone
5. Open a second browser tab, log in as a different user
6. Tick a milestone in tab 1 → it should appear in tab 2 within 15 seconds

---

## Step 8 — Enable real-time updates (optional, Phase 2)

Supabase supports WebSocket subscriptions — changes appear instantly for all
users with no polling at all. To enable:

In your frontend, add after `store(d)` in `bootApp()`:

```javascript
// Real-time subscription — replaces the 15s poll entirely
var supabaseClient = window.supabase.createClient(
  'https://your-project.supabase.co',
  'your-anon-key'  // Use ANON key here (not service role)
);

supabaseClient
  .channel('progress-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'progress' },
    function(payload) { silentReload(); })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'students' },
    function(payload) { silentReload(); })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'cohorts' },
    function(payload) { silentReload(); })
  .subscribe();
```

This makes ProjectAxis behave like a live collaborative app — when admin
ticks a milestone, every supervisor sees it immediately with no page refresh.

---

## Ongoing costs

| Service | Free tier | Paid |
|---|---|---|
| Supabase | 500MB DB, 2GB bandwidth/month | $25/month for 8GB |
| Railway | $5 free credit/month | ~$5-10/month |
| Netlify (frontend) | 100GB bandwidth | Free for this size |
| **Total** | **Free for small use** | **~$5-10/month** |

For OCB's scale (hundreds of students, not millions), the free tiers will
likely be sufficient for years.

---

## Troubleshooting

**CORS error in browser console:**
→ In Railway Variables, set `FRONTEND_URL` to your exact frontend domain
   (e.g. `https://your-site.netlify.app`). Do not include trailing slash.

**401 Unauthorized after login:**
→ Check `JWT_SECRET` is set in Railway and matches between deployments.
   If you change it, all users need to log in again.

**"Student has no email address" on reminders:**
→ Ensure student records have email fields populated.

**Supabase connection error:**
→ Check `SUPABASE_URL` has no trailing slash.
→ Check `SUPABASE_SERVICE_ROLE_KEY` is the `service_role` key, not `anon`.

**Data missing after migration:**
→ Check column name mapping above. Supabase uses snake_case, Sheets used PascalCase.
→ Foreign keys must be integers — ensure IDs from Sheets are numbers not strings.
