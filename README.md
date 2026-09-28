# EDU-SAAS Backend

Node.js + Express + Prisma. Two environments out of the box:

| Env | Storage | File | Use case |
|---|---|---|---|
| **dev** | In-memory (resets on restart) | `.env.dev` | Local UI work, demos, no DB needed |
| **stage** | Azure PostgreSQL (persistent) | `.env.stage` | Real data, integration testing |

Both files are gitignored — they hold secrets.

## Setup

```bash
npm install
```


Install dependencies and configure the required environment files (`.env.dev` and `.env.stage`) using the values provided by your team.

## Run

### 1. HTTP API (server.js)

```bash
npm run start:dev    # in-memory / local dev env
npm run start:stage  # connects to persistent Postgres
npm start            # alias for start:stage
npm run dev          # nodemon + dev env
npm run dev:stage    # nodemon + stage env
```

On boot you'll see `[env] APP_ENV=dev` or `[env] APP_ENV=stage` so you always know which one is active.

- API root: http://localhost:5000
- Swagger UI: http://localhost:5000/api-docs

### 2. Static Analysis Worker (worker.js)

The static analysis worker processes queued mini-project submissions in the background. It clones student code at the submitted commit to a temporary folder, runs Semgrep, and stores findings in PostgreSQL. It does **not** execute student code and does **not** create Docker containers per submission.

**Prerequisite:** Semgrep must be installed in the environment running the worker:
```bash
pip install semgrep
semgrep --version
```

**Run the worker:**
```bash
npm run worker:dev   # worker with dev env
npm run worker:stage # worker with stage env
npm run worker       # alias for worker:stage (or: node worker.js)
```

### 3. Coding Assessment Sandboxing (Docker)

Docker is used **strictly** for executing untrusted student code during live coding assessments (`src/services/dockerService.js`), providing process, CPU, memory, and network isolation.
- Docker is **NOT** required for deploying the API or worker.
- Docker is **NOT** required for mini-project static analysis.
- When running coding assessments, ensure Docker Desktop / engine is active on the host.

For full production architecture and process management (PM2, systemd, PaaS), see [DEPLOYMENT.md](DEPLOYMENT.md).

## How env selection works

`src/config/env.js` reads `APP_ENV` and loads `.env.<APP_ENV>` first, then `.env` as a fallback. The npm scripts above set `APP_ENV` automatically via `cross-env`.

If you want to add a third env (e.g. `prod`):
1. Create `.env.prod` (already gitignored)
2. Run `cross-env APP_ENV=prod node server.js`

## Test users (seeded in both envs)

| Email | Password | Role |
|---|---|---|
| `admin@edu.local` | `admin123` | admin |
| `priya.sharma@email.com` | `demo123` | student |
| `yash@educator.local` | `demo123` | educator |
| `ankit@employer.local` | `demo123` | employer |

Or sign up new users via the UI — in **stage** they persist, in **dev** they live until the next restart.

## Working with the Azure DB

Prisma commands need to read `.env.stage`, so use the staged scripts:

```bash
npm run db:migrate:stage    # apply pending migrations
npm run db:seed:stage       # seed roles/permissions/users
npm run db:studio:stage     # open Prisma Studio
npm run db:push:stage       # push schema without a migration
npm run db:generate         # regenerate Prisma Client (no DB needed)
```

The DB schema lives in `education` (not `public`). See [prisma/schema.prisma](prisma/schema.prisma).

## RBAC

Roles + permissions are stored in dedicated tables (`roles`, `permissions`, `role_permissions`). The canonical catalog is defined in [src/config/rbac.js](src/config/rbac.js) — edit there, then re-seed.

```bash
npm run db:seed:stage   # re-runs upserts; safe to re-run
```

Routes use `permissionRequired('courses:create')` from [src/middleware/auth.js](src/middleware/auth.js).

## Troubleshooting

**`P1001: Can't reach database server`**
- Verify you're on a network that can reach the Azure private endpoint.
- Test: `npm run db:studio:stage` — if Studio opens, connectivity is fine.

**`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / TLS errors**
The Azure cert chain isn't trusted by Node by default. `.env.stage` already sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for this reason. For prod you should install the proper CA bundle instead.

**Forgot which env you're in**
Look at the server boot log — `[env] APP_ENV=...` is the first line. Or `curl localhost:5000` returns the API root.

## Project layout

```
src/
├── config/         env (APP_ENV-aware), swagger, rbac catalog
├── data/           repo toggle (memory + Prisma) + dataStore seed
├── middleware/     authentication, RBAC authorization, error handling
└── routes/         one file per resource
prisma/
├── schema.prisma   data model (26 tables under `education` schema)
├── migrations/     versioned schema changes
└── seed.js         run via `npm run db:seed:stage`
```
## Development 
Db connected successfully