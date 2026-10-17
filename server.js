'use strict';
/**
 * CampusIQ backend — zero dependencies (Node >= 22.13).
 * Persistence: SQLite via the built-in node:sqlite module.
 * Serves the frontend from /public and a JSON REST API under /api.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || '/tmp/campusiq.db';
const API_KEY = process.env.API_KEY || ''; // optional: if set, all /api calls need header x-api-key
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS students(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT DEFAULT '', phone TEXT DEFAULT '',
  department TEXT NOT NULL, batch TEXT NOT NULL, cgpa REAL DEFAULT 0, skills TEXT DEFAULT '',
  eligible INTEGER DEFAULT 1, status TEXT NOT NULL DEFAULT 'Unplaced',
  companyId TEXT DEFAULT '', role TEXT DEFAULT '', packageLpa REAL DEFAULT 0, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS companies(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT DEFAULT '', website TEXT DEFAULT '',
  role TEXT DEFAULT '', packageLpa REAL DEFAULT 0, visitDate TEXT DEFAULT '', location TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS history(
  id TEXT PRIMARY KEY, studentId TEXT NOT NULL, company TEXT DEFAULT '—', role TEXT DEFAULT '—',
  outcome TEXT NOT NULL, notes TEXT DEFAULT '', date TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_history_student ON history(studentId);
`);

/* ---------- helpers ---------- */
const STATUSES = ['Placed', 'Unplaced', 'In Process', 'Not Eligible'];
const OUTCOMES = ['Applied', 'Shortlisted', 'Interview', 'Selected', 'Rejected', 'Offer Accepted', 'Offer Declined', 'Status Updated'];
const uid = () => crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
const now = () => new Date().toISOString();
const norm = s => String(s ?? '').trim().toLowerCase();
const str = v => (v == null ? '' : String(v).trim());
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (m) => new HttpError(400, m);

const mapStudent = r => r && ({ ...r, eligible: !!r.eligible });
const getStudent = id => mapStudent(db.prepare('SELECT * FROM students WHERE id=?').get(id));
const getCompany = id => db.prepare('SELECT * FROM companies WHERE id=?').get(id);
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

function addHistory(studentId, company, outcome, notes, role, date) {
  db.prepare('INSERT INTO history(id,studentId,company,role,outcome,notes,date) VALUES(?,?,?,?,?,?,?)')
    .run(uid() + uid(), studentId, company || '—', role || '—', outcome, notes || '', date || now());
}

function snapshot() {
  return {
    students: db.prepare('SELECT * FROM students ORDER BY createdAt DESC, rowid DESC').all().map(mapStudent),
    companies: db.prepare('SELECT * FROM companies ORDER BY rowid').all(),
    history: db.prepare('SELECT * FROM history ORDER BY date DESC').all(),
  };
}

/* ---------- seed ---------- */
function seed() {
  const t = now();
  const S = [
    ['CIQ-1001','Aarav Sharma','aarav.sharma@campus.edu','9876501001','Computer Science','2026',8.7,'Python, SQL, React',1,'Placed','co1','Software Engineer',8.5],
    ['CIQ-1002','Ananya Verma','ananya.verma@campus.edu','9876501002','Information Technology','2026',9.1,'Java, DSA, Spring Boot',1,'In Process','co2','Graduate Engineer Trainee',0],
    ['CIQ-1003','Rohan Mehta','rohan.mehta@campus.edu','9876501003','Computer Science','2026',7.8,'C++, DSA, Linux',1,'Unplaced','','',0],
    ['CIQ-1004','Priya Singh','priya.singh@campus.edu','9876501004','Electronics','2026',8.4,'Embedded C, IoT, Python',1,'Placed','co3','Embedded Systems Associate',6.2],
    ['CIQ-1005','Kabir Gupta','kabir.gupta@campus.edu','9876501005','Business Administration','2026',7.2,'Excel, Power BI, Communication',1,'Unplaced','','',0],
    ['CIQ-1006','Isha Kapoor','isha.kapoor@campus.edu','9876501006','Information Technology','2027',6.1,'HTML, CSS, JavaScript',0,'Not Eligible','','',0],
    ['CIQ-1007','Dev Malhotra','dev.malhotra@campus.edu','9876501007','Computer Science','2027',8.2,'Java, SQL, Git',1,'In Process','co1','Associate Developer',0],
    ['CIQ-1008','Meera Joshi','meera.joshi@campus.edu','9876501008','Business Administration','2026',8.9,'Marketing, Analytics, PowerPoint',1,'Placed','co2','Business Analyst',7.0],
  ];
  const C = [
    ['co1','NexaTech Solutions','Technology & Software','https://example.com','Software Engineer',8.5,'2026-09-12','Gurugram'],
    ['co2','Vertex Global','Consulting & Analytics','https://example.com','Business Analyst / GET',7,'2026-09-20','Noida'],
    ['co3','Aether Embedded','Electronics & IoT','https://example.com','Embedded Systems Associate',6.2,'2026-10-02','Chandigarh'],
  ];
  const H = [
    ['CIQ-1001','NexaTech Solutions','Software Engineer','Offer Accepted','Offer accepted by student; package 8.5 LPA.'],
    ['CIQ-1002','Vertex Global','Graduate Engineer Trainee','Interview','Technical interview scheduled / in progress.'],
    ['CIQ-1004','Aether Embedded','Embedded Systems Associate','Selected','Selected after technical and HR rounds.'],
    ['CIQ-1008','Vertex Global','Business Analyst','Offer Accepted','Offer accepted by student; package 7.0 LPA.'],
  ];
  tx(() => {
    const is = db.prepare('INSERT INTO students VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    S.forEach(s => is.run(...s, t));
    const ic = db.prepare('INSERT INTO companies VALUES(?,?,?,?,?,?,?,?)');
    C.forEach(c => ic.run(...c));
    H.forEach(h => addHistory(h[0], h[1], h[3], h[4], h[2], t));
  });
}
function reset() { tx(() => { db.exec('DELETE FROM history; DELETE FROM students; DELETE FROM companies;'); }); seed(); }
if (db.prepare('SELECT COUNT(*) n FROM students').get().n === 0 && db.prepare('SELECT COUNT(*) n FROM companies').get().n === 0) seed();

/* ---------- business logic ---------- */
function cleanStudent(b, { partial } = {}) {
  const x = {
    id: str(b.id), name: str(b.name), email: str(b.email), phone: str(b.phone),
    department: str(b.department), batch: str(b.batch), cgpa: Number(b.cgpa) || 0, skills: str(b.skills),
    status: str(b.status) || 'Unplaced', eligible: b.eligible === true || b.eligible === 'true',
    companyId: str(b.companyId), role: str(b.role), packageLpa: Number(b.packageLpa) || 0,
  };
  if (b.eligible === undefined) x.eligible = true;
  if (!x.id) throw bad('Student ID is required.');
  if (!x.name) throw bad('Name is required.');
  if (!x.department) throw bad('Department is required.');
  if (!x.batch) throw bad('Batch is required.');
  if (!STATUSES.includes(x.status)) throw bad('Invalid status.');
  if (x.cgpa < 0 || x.cgpa > 10) throw bad('CGPA must be between 0 and 10.');
  if (x.packageLpa < 0) throw bad('Package cannot be negative.');
  if (x.email && !/^\S+@\S+\.\S+$/.test(x.email)) throw bad('Invalid email address.');
  if (x.status === 'Not Eligible') x.eligible = false;
  if (x.companyId && !getCompany(x.companyId)) throw bad('Unknown company.');
  if (x.status === 'Placed' && !x.companyId) throw bad('Add a company for a placed student.');
  return x;
}
function writeStudent(x, createdAt) {
  db.prepare(`INSERT INTO students(id,name,email,phone,department,batch,cgpa,skills,eligible,status,companyId,role,packageLpa,createdAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,department=excluded.department,
    batch=excluded.batch,cgpa=excluded.cgpa,skills=excluded.skills,eligible=excluded.eligible,status=excluded.status,
    companyId=excluded.companyId,role=excluded.role,packageLpa=excluded.packageLpa`)
    .run(x.id, x.name, x.email, x.phone, x.department, x.batch, x.cgpa, x.skills, x.eligible ? 1 : 0, x.status, x.companyId, x.role, x.packageLpa, createdAt);
}

function createStudent(body) {
  const x = cleanStudent(body);
  if (getStudent(x.id)) throw new HttpError(409, 'That student ID already exists.');
  return tx(() => {
    const co = x.companyId ? getCompany(x.companyId) : null;
    if (x.status === 'Placed' && co) {
      x.role = x.role || co.role || '';
      addHistory(x.id, co.name, 'Selected', `Student status set to Placed. Package: ${x.packageLpa || 'Not specified'} LPA.`, x.role);
    }
    writeStudent(x, now());
    addHistory(x.id, co?.name, 'Applied', 'Student record created.', x.role);
    return getStudent(x.id);
  });
}
function updateStudent(id, body) {
  const old = getStudent(id);
  if (!old) throw new HttpError(404, 'Student not found.');
  const x = cleanStudent({ ...body, id });
  return tx(() => {
    const co = x.companyId ? getCompany(x.companyId) : null;
    if (x.status !== old.status) {
      if (x.status === 'Placed' && co) {
        x.role = x.role || co.role || '';
        addHistory(id, co.name, 'Selected', `Student status set to Placed. Package: ${x.packageLpa || 'Not specified'} LPA.`, x.role);
      } else addHistory(id, co?.name, 'Status Updated', `Status changed from ${old.status} to ${x.status}.`, x.role);
    }
    writeStudent(x, old.createdAt);
    return getStudent(id);
  });
}
function deleteStudent(id) {
  if (!getStudent(id)) throw new HttpError(404, 'Student not found.');
  tx(() => { db.prepare('DELETE FROM history WHERE studentId=?').run(id); db.prepare('DELETE FROM students WHERE id=?').run(id); });
}

function cleanCompany(b) {
  const x = { name: str(b.name), industry: str(b.industry), role: str(b.role), packageLpa: Number(b.packageLpa) || 0,
    visitDate: str(b.visitDate), location: str(b.location), website: str(b.website) };
  if (!x.name) throw bad('Company name is required.');
  if (!x.role) throw bad('Job role is required.');
  if (x.packageLpa < 0) throw bad('Package cannot be negative.');
  return x;
}
function createCompany(body) {
  const x = cleanCompany(body), id = 'co' + uid();
  db.prepare('INSERT INTO companies VALUES(?,?,?,?,?,?,?,?)').run(id, x.name, x.industry, x.website, x.role, x.packageLpa, x.visitDate, x.location);
  return getCompany(id);
}
function updateCompany(id, body) {
  const old = getCompany(id); if (!old) throw new HttpError(404, 'Company not found.');
  const x = cleanCompany(body);
  tx(() => {
    db.prepare('UPDATE companies SET name=?,industry=?,website=?,role=?,packageLpa=?,visitDate=?,location=? WHERE id=?')
      .run(x.name, x.industry, x.website, x.role, x.packageLpa, x.visitDate, x.location, id);
    if (old.name !== x.name) db.prepare('UPDATE history SET company=? WHERE company=?').run(x.name, old.name); // keep history linked
  });
  return getCompany(id);
}
function deleteCompany(id) {
  if (!getCompany(id)) throw new HttpError(404, 'Company not found.');
  db.prepare('DELETE FROM companies WHERE id=?').run(id);
}

function createHistory(b) {
  const s = getStudent(str(b.studentId)); if (!s) throw bad('Student not found.');
  const outcome = str(b.outcome); if (!OUTCOMES.includes(outcome)) throw bad('Invalid outcome.');
  const companyName = str(b.company), role = str(b.role);
  const d = b.date ? new Date(str(b.date).length === 10 ? str(b.date) + 'T12:00:00' : b.date) : new Date();
  if (isNaN(d)) throw bad('Invalid date.');
  const co = db.prepare('SELECT * FROM companies WHERE name=?').get(companyName);
  let next = str(b.newStatus);
  if (next && !STATUSES.includes(next)) throw bad('Invalid status.');
  if (!next && ['Selected', 'Offer Accepted'].includes(outcome)) next = 'Placed';
  if (!next && outcome === 'Rejected') next = 'Unplaced';
  return tx(() => {
    addHistory(s.id, companyName, outcome, str(b.notes), role, d.toISOString());
    if (next) {
      const u = { status: next, eligible: next !== 'Not Eligible' ? 1 : 0, companyId: s.companyId, role: s.role, packageLpa: s.packageLpa };
      if (next === 'Placed') { u.companyId = co?.id || s.companyId; u.role = role || co?.role || s.role; u.packageLpa = co?.packageLpa || s.packageLpa; }
      db.prepare('UPDATE students SET status=?,eligible=?,companyId=?,role=?,packageLpa=? WHERE id=?').run(u.status, u.eligible, u.companyId, u.role, u.packageLpa, s.id);
    }
    if (co && role && !co.role) db.prepare('UPDATE companies SET role=? WHERE id=?').run(role, co.id);
    return snapshot();
  });
}
function deleteHistory(id) {
  const r = db.prepare('DELETE FROM history WHERE id=?').run(id);
  if (!r.changes) throw new HttpError(404, 'History entry not found.');
}

function importStudents(rows) {
  if (!Array.isArray(rows) || !rows.length) throw bad('No rows to import.');
  if (rows.length > 20000) throw bad('Too many rows (max 20000).');
  let added = 0, updated = 0, skipped = 0;
  tx(() => {
    rows.forEach((r, n) => {
      const name = str(r.name); if (!name) { skipped++; return; }
      const id = str(r.id) || 'CIQ-' + Date.now().toString().slice(-6) + n;
      const existing = getStudent(id);
      const coName = str(r.company);
      let co = coName ? db.prepare('SELECT * FROM companies WHERE lower(name)=?').get(norm(coName)) : null;
      if (coName && !co) {
        const cid = 'co' + uid();
        db.prepare('INSERT INTO companies VALUES(?,?,?,?,?,?,?,?)').run(cid, coName, 'Imported', '', str(r.role), Number(r.packageLpa) || 0, '', '');
        co = getCompany(cid);
      }
      let status = str(r.status);
      if (!STATUSES.includes(status)) status = norm(r.eligible) === 'false' ? 'Not Eligible' : 'Unplaced';
      if (status === 'Placed' && !co) status = 'In Process';
      const x = {
        id, name, email: str(r.email), phone: str(r.phone), department: str(r.department) || 'Unassigned',
        batch: str(r.batch) || 'Unspecified', cgpa: Math.min(10, Math.max(0, Number(r.cgpa) || 0)), skills: str(r.skills),
        eligible: status !== 'Not Eligible' && norm(r.eligible) !== 'false', status, companyId: co?.id || '',
        role: str(r.role) || co?.role || '', packageLpa: Number(r.packageLpa) || co?.packageLpa || 0,
      };
      writeStudent(x, existing?.createdAt || now());
      existing ? updated++ : added++;
    });
  });
  return { added, updated, skipped };
}

/* ---------- reports (CSV) ---------- */
const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCSV = rows => '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
const isSel = o => o === 'Selected' || o === 'Offer Accepted';
function rate(a) {
  const el = a.filter(s => s.eligible && s.status !== 'Not Eligible').length, p = a.filter(s => s.status === 'Placed').length;
  return { el, p, pct: el ? Math.round(p / el * 100) : 0 };
}
const REPORTS = {
  'student-master': () => {
    const { students, companies } = snapshot(); const cn = id => companies.find(c => c.id === id)?.name || '';
    return ['campusiq_student_master.csv', [['Student ID','Name','Email','Phone','Department','Batch','CGPA','Skills','Eligible','Status','Company','Role','Package LPA','Created At'],
      ...students.map(s => [s.id,s.name,s.email,s.phone,s.department,s.batch,s.cgpa,s.skills,s.eligible?'Yes':'No',s.status,cn(s.companyId),s.role,s.packageLpa,s.createdAt])]];
  },
  'department': () => {
    const { students } = snapshot();
    return ['campusiq_department_report.csv', [['Department','Batch','Total Students','Eligible Students','Placed','Unplaced Eligible','In Process','Not Eligible','Placement Rate %'],
      ...[...new Set(students.map(s => s.department))].map(d => { const a = students.filter(s => s.department === d), r = rate(a);
        return [d,'All',a.length,r.el,r.p,a.filter(s=>s.status==='Unplaced'&&s.eligible).length,a.filter(s=>s.status==='In Process').length,a.filter(s=>s.status==='Not Eligible').length,r.pct]; })]];
  },
  'batch': () => {
    const { students } = snapshot();
    return ['campusiq_batch_report.csv', [['Batch','Total Students','Eligible Students','Placed','Unplaced Eligible','In Process','Placement Rate %'],
      ...[...new Set(students.map(s => s.batch))].map(b => { const a = students.filter(s => s.batch === b), r = rate(a);
        return [b,a.length,r.el,r.p,a.filter(s=>s.status==='Unplaced'&&s.eligible).length,a.filter(s=>s.status==='In Process').length,r.pct]; })]];
  },
  'history': () => {
    const { students, history } = snapshot();
    return ['campusiq_placement_history.csv', [['Date','Student ID','Student Name','Company','Role','Outcome','Notes'],
      ...history.map(h => [h.date,h.studentId,students.find(s=>s.id===h.studentId)?.name||'',h.company,h.role,h.outcome,h.notes])]];
  },
  'companies': () => {
    const { companies, history } = snapshot();
    return ['campusiq_company_selections.csv', [['Company','Industry','Role','Package LPA','Visit Date','Location','Selections Logged'],
      ...companies.map(c => [c.name,c.industry,c.role,c.packageLpa,c.visitDate,c.location,history.filter(h=>h.company===c.name&&isSel(h.outcome)).length])]];
  },
  'import-template': () => ['campusiq_student_import_template.csv', [
    ['id','name','email','phone','department','batch','cgpa','skills','eligible','status','company','role','packageLpa'],
    ['CIQ-2001','Sample Student','student@college.edu','9999999999','Computer Science','2027','8.0','Python, SQL','true','Unplaced','','','0']]],
};

function stats() {
  const { students, companies, history } = snapshot();
  const r = rate(students);
  return {
    totalStudents: students.length, eligible: r.el, placed: r.p, placementRate: r.pct,
    inProcess: students.filter(s => s.status === 'In Process').length,
    unplacedEligible: students.filter(s => s.status === 'Unplaced' && s.eligible).length,
    notEligible: students.filter(s => s.status === 'Not Eligible').length,
    companies: companies.length, selections: history.filter(h => isSel(h.outcome)).length,
    departments: [...new Set(students.map(s => s.department))].map(d => { const q = rate(students.filter(s => s.department === d)); return { department: d, eligible: q.el, placed: q.p, rate: q.pct }; }),
  };
}

/* ---------- HTTP layer ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const send = (res, code, data, headers = {}) => {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
};
const readBody = req => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 10 * 1024 * 1024) { reject(new HttpError(413, 'Payload too large.')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('Invalid JSON body.')); } });
  req.on('error', reject);
});

async function api(req, res, url) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) throw new HttpError(401, 'Invalid or missing API key.');
  const p = url.pathname.replace(/\/+$/, ''), m = req.method;
  let seg = p.split('/').slice(2); // after /api
  const [res0, id] = seg;
  if (p === '/api/health') return send(res, 200, { ok: true, time: now() });
  if (p === '/api/db' && m === 'GET') return send(res, 200, snapshot());
  if (p === '/api/stats' && m === 'GET') return send(res, 200, stats());
  if (p === '/api/reset' && m === 'POST') { reset(); return send(res, 200, snapshot()); }
  if (res0 === 'reports' && m === 'GET') {
    const r = REPORTS[id]; if (!r) throw new HttpError(404, 'Unknown report.');
    const [fname, rows] = r();
    return send(res, 200, toCSV(rows), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` });
  }
  if (res0 === 'students') {
    if (!id && m === 'GET') return send(res, 200, snapshot().students);
    if (!id && m === 'POST') return send(res, 201, createStudent(await readBody(req)));
    if (id === 'import' && m === 'POST') return send(res, 200, importStudents((await readBody(req)).rows));
    if (id && m === 'GET') { const s = getStudent(decodeURIComponent(id)); if (!s) throw new HttpError(404, 'Student not found.'); return send(res, 200, s); }
    if (id && m === 'PUT') return send(res, 200, updateStudent(decodeURIComponent(id), await readBody(req)));
    if (id && m === 'DELETE') { deleteStudent(decodeURIComponent(id)); return send(res, 200, { deleted: true }); }
  }
  if (res0 === 'companies') {
    if (!id && m === 'GET') return send(res, 200, snapshot().companies);
    if (!id && m === 'POST') return send(res, 201, createCompany(await readBody(req)));
    if (id && m === 'PUT') return send(res, 200, updateCompany(id, await readBody(req)));
    if (id && m === 'DELETE') { deleteCompany(id); return send(res, 200, { deleted: true }); }
  }
  if (res0 === 'history') {
    if (!id && m === 'GET') return send(res, 200, snapshot().history);
    if (!id && m === 'POST') return send(res, 201, createHistory(await readBody(req)));
    if (id && m === 'DELETE') { deleteHistory(id); return send(res, 200, { deleted: true }); }
  }
  throw new HttpError(404, 'Not found.');
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
  let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden.' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found.' });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e instanceof HttpError ? e.code : 500, { error: e instanceof HttpError ? e.message : 'Internal server error.' });
  }
});
server.listen(PORT, () => console.log(`CampusIQ running at http://localhost:${PORT}  (db: ${DB_FILE})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
