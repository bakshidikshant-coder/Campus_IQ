# CampusIQ – Backend Edition

Node.js + SQLite backend for the CampusIQ Placement Intelligence app. **No npm install needed** (zero dependencies).

## Run
Requires Node.js 22.13 or newer.

    node server.js
    # open http://localhost:3000

Env vars: `PORT` (default 3000), `DB_FILE` (default `data/campusiq.db`), `API_KEY` (optional; if set, `/api` calls need header `x-api-key`).

The database is created and seeded with demo data on first run. Data is persisted in `data/campusiq.db`.

## API
| Method | Path | Purpose |
|---|---|---|
| GET | /api/db | all students, companies, history |
| GET | /api/stats | placement KPIs + department rates |
| GET/POST | /api/students | list / create |
| GET/PUT/DELETE | /api/students/:id | read / update / delete (cascades history) |
| POST | /api/students/import | bulk import `{rows:[...]}` |
| GET/POST | /api/companies | list / create |
| PUT/DELETE | /api/companies/:id | update / delete |
| GET/POST | /api/history | list / log activity (auto-updates student status) |
| DELETE | /api/history/:id | delete entry |
| GET | /api/reports/{student-master,department,batch,history,companies,import-template} | CSV downloads |
| POST | /api/reset | restore demo data |
| GET | /api/health | health check |

Validation, status rules, history auto-logging and CSV reports now run on the server.
