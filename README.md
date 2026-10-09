# Flow Platform — backend

Workflow automation backend (n8n-style): NestJS 12, TypeORM + PostgreSQL, BullMQ + Redis, S3-compatible object storage, socket.io.

## Getting started

```bash
cp .env.example .env
# set secrets in .env: ENCRYPTION_KEY (openssl rand -base64 32), JWT_SECRET (openssl rand -base64 48)
docker compose up -d              # Postgres :5440, Redis :6390, S3 (SeaweedFS) :9010
npm install
npm run start:dev                 # APP_ROLE=all: API + worker in one process; migrations run on startup
```

- API: http://localhost:3000/api
- First run: create the owner account with `POST /api/auth/setup { email, name, password }`, or from the frontend
- Swagger UI: http://localhost:3000/docs (OpenAPI JSON at `/docs/openapi.json`; the frontend generates its types from it)
- Webhooks: http://localhost:3000/webhook/&lt;path&gt;
- WebSocket: socket.io namespace `/executions`

## Running with Docker

```bash
docker compose --profile app up --build -d   # api on :3000 (APP_PORT) + worker, using .env secrets
```

One image (`Dockerfile`) serves both roles; only `api` runs migrations. `GET /api/health` is liveness, and `GET /api/health/ready` checks Postgres, Redis and S3 (503 when one is down). Behind a reverse proxy set `TRUST_PROXY` (for example `1` or `loopback,10.0.0.0/8`), otherwise login rate limiting sees the proxy's IP. CI (`.github/workflows/ci.yml`) runs lint, type check, unit and e2e tests, and builds the image. It needs npm 12, see `packageManager`.

## Process roles

One codebase, selected by `APP_ROLE`:

| Role | Runs |
|---|---|
| `api` | REST API, webhooks, WebSocket gateway. Enqueues runs, never executes them |
| `worker` | BullMQ consumer: executes runs and Schedule triggers. No HTTP server |
| `all` | Both, for local development and tests |

In production run `api` and `worker` separately and scale workers horizontally (`WORKER_CONCURRENCY` jobs each).

```
POST /api/workflows/:id/run ─┐
POST /webhook/<path> ────────┼─► executions row (queued) ─► BullMQ "workflows" ─► worker ─► WorkflowRunner
BullMQ job scheduler (cron) ─┘                                                     │
                                       browser ◄─ socket.io ◄─ API ◄─ Redis pub/sub ◄┘ (progress events)
```

## Authentication

- **Access token**: a JWT (HS256, 15 min, `ACCESS_TOKEN_TTL_SECONDS`) sent as `Authorization: Bearer <token>`.
- **Refresh token**: an opaque random token in the httpOnly cookie `flow_refresh` (path `/api/auth`, SameSite=Lax, Secure in production). Only its SHA-256 is stored. `POST /api/auth/refresh` rotates it, and reusing an already-rotated token revokes every session of that login (theft detection). Logout and password change revoke sessions too.
- **Passwords** are hashed with scrypt (N=2¹⁷, r=8, p=1). Login is rate-limited in Redis to 5 attempts per email and 30 per IP per 15 minutes. Unknown emails take as long as wrong passwords.
- **Deny by default**: a global guard requires a token and workspace membership on every route unless it is marked `@Public()` (setup, login, refresh, invitations, health, webhooks) or `@UserOnly()` (`/auth/me`, `/auth/password`).
- **Workspaces and roles**: `viewer` reads, `editor` creates, edits and runs workflows and manages credentials, `admin` manages members and invitations (except admins and owners), and `owner` manages everything. A workspace always keeps at least one owner. A user in several workspaces picks one with the `X-Workspace-Id` header. All data access is scoped to that workspace, so another workspace's ids return 404.
- **Onboarding**: the first user is created with `POST /api/auth/setup`, which works only while no users exist. Everyone else joins by invitation: an admin calls `POST /api/workspace/invitations` and gets a one-time token valid for 7 days. Email delivery is not built yet, so the frontend shows the link. The invitee calls `POST /api/auth/invitations/:token/accept`.
- **WebSocket**: connect with `io('/executions', { auth: { token } })`. Each subscription is checked against the user's workspaces.
- **Fetch with cookies**: the frontend must send `credentials: 'include'` (axios: `withCredentials: true`) on `/api/auth/*` calls, and its origin must be in `CORS_ORIGINS`.

## How it works

- **Runs** are rows in `executions` (status `queued → running → success|error`) plus one `execution_steps` row per executed node. The queue only carries the execution id. A worker claims a run with a conditional `UPDATE ... WHERE status = 'queued'`, so a duplicated job cannot execute twice.
- **No automatic retries.** Jobs have `attempts: 1` and `maxStalledCount: 0`, because nodes may have side effects. If a worker dies mid-run, the run is marked `error` and is not re-run.
- **Activation** (`PUT /api/workflows/:id { active: true }`) registers the workflow's triggers:
  - **Webhook nodes** get rows in the `webhooks` table, written in the same transaction as the workflow save. Path conflicts return 409 and roll back the save.
  - **Schedule nodes** become BullMQ job schedulers in Redis (`schedule:<workflowId>:<nodeId>`). On startup the schedulers are reconciled against active workflows, and a worker that fires a stale scheduler removes it.
  - **Saving** an active workflow re-syncs its triggers. **Deactivating** or **deleting** it removes them.
- **Editor runs**: `POST /run` accepts `destinationNodeId` (run only that node and what it depends on) and `runFromNodeId` (re-run from a node). In the second case the upstream outputs come from an earlier execution: `sourceExecutionId`, or by default the latest finished one, following chains of partial runs. **Pinned data** (`PUT /workflows/:id { pinData: { nodeId: [json…] } }`) replaces node execution in manual runs only. Steps report `pinned: true`.
- **Test webhooks**: `POST /api/workflows/:id/test-webhook` listens for 2 minutes on `/webhook-test/<path>` for the saved workflow, without activating it. The first request is consumed and runs as a manual execution, so pinned data applies.
- **History**: finished executions older than `EXECUTIONS_MAX_AGE_DAYS` (default 14, `0` keeps them) are deleted hourly together with their steps and files.
- **Retries** are per node: `retryOnFail`, `maxTries` (≤ 10) and `waitBetweenTriesMs` on the graph node. `execution_steps.tries` records the attempts.
- **Timeouts and cancel** share one AbortSignal per run. The timeout is `settings.timeoutSeconds`, capped by `EXECUTION_TIMEOUT_MAX_SECONDS`, and a timed-out run ends as `error` (`ExecutionTimeoutError`). `POST /api/executions/:id/cancel` cancels a queued run directly. For a running one the API publishes a cancel request over Redis, and the worker holding the run aborts it. The runner stops between nodes, during retry waits and mid-node: it stops waiting for the node's promise even if the node ignores the signal.
- **Error workflows**: `settings.errorWorkflowId` points to a workflow with an **Error Trigger**. When a webhook or schedule run fails, that workflow is started with `{ execution: { id, mode, error, lastNodeExecuted, startedAt }, workflow: { id, name } }`. As in n8n, manual runs and failures of error workflows do not trigger it.
- **Binary data**: items carry `binary: { [field]: { id, fileName, mimeType, size } }`, and the bytes live in S3 under `<workspaceId>/<id>`, with metadata in `binary_data`. Nodes use `ctx.helpers.storeBinary/readBinary`. Webhooks store multipart files and raw non-JSON bodies (field `data`). Deleting a workflow orphans its files, and an hourly job deletes them. Any S3 service works; compose uses SeaweedFS because MinIO no longer publishes public images.
- **Credentials** are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. The API never returns fields marked `secret`. `PUT` merges data, so omitted fields keep their stored values. If the key is lost, stored credentials become unreadable.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Unit tests (engine, nodes, cipher; no DB) |
| `npm run test:e2e` | Full-stack tests; needs `docker compose up -d` and `.env`. Uses its own database `flow_test` (created automatically), Redis db 1 and bucket, so dev data is untouched |
| `npm run migration:generate src/database/migrations/<Name>` | Diff entities against the DB and write a migration |
| `npm run migration:run` / `migration:revert` | Apply / roll back migrations |

New migrations must be added to `src/database/migrations/index.ts`. Entities and migrations are listed explicitly because glob paths are unreliable under ESM.

## Layout

```
src/
  engine/        Framework-free execution engine: graph types and validation,
                 expression resolver ({{ $json.x }}), WorkflowRunner
  nodes/         Built-in nodes and credential types (see "Nodes" below)
  queue/         BullMQ queue name, job names and payloads
  modules/
    workflows/   CRUD; every graph change creates an immutable WorkflowVersion
    executions/  Creates queued runs, waits for them, history
    worker/      Queue processor and ExecutionExecutor (worker role only)
    triggers/    Activation: webhook routing table and cron job schedulers
    webhooks/    Public /webhook/* endpoint (api role only)
    credentials/ Encrypted credential storage
    binary-data/ S3 storage of item files, download endpoint, orphan cleanup
    expressions/ Autocomplete reference and live evaluation for the editor
    events/      Redis pub/sub of execution progress + socket.io gateway
    node-types/  NodeRegistry + GET /api/node-types (the editor builds forms from it)
    auth/        Users, sessions (JWT + rotating refresh cookie), global guard, roles
    workspaces/  Tenant boundary: members, roles, invitations
  database/      TypeORM options, CLI data source, migrations
```

## API

All `/api/*` routes need `Authorization: Bearer <token>` except setup, login, refresh, logout, invitation lookup/accept and health.

| Method | Path | |
|---|---|---|
| GET, POST | `/api/auth/setup` | First-run status / create the first owner |
| POST | `/api/auth/login`, `/refresh`, `/logout` | Sessions (refresh token in cookie) |
| GET | `/api/auth/me` | User and workspace memberships |
| POST | `/api/auth/password` | Change password (signs out other sessions) |
| GET, POST | `/api/auth/invitations/:token[/accept]` | Look up / accept an invitation |
| GET, PATCH | `/api/workspace` | Current workspace / rename (admin) |
| GET, PATCH, DELETE | `/api/workspace/members[/:userId]` | Members, change role, remove (admin) or leave |
| GET, POST, DELETE | `/api/workspace/invitations[/:id]` | Pending invitations (admin) |
| GET | `/api/node-types` | Node type descriptions |
| GET, POST | `/api/workflows` | List (paginated) / create |
| GET, PUT, DELETE | `/api/workflows/:id` | Read / update (`graph` → new version, `active` → (de)activate triggers, `settings` → `{ errorWorkflowId, timeoutSeconds }`, `null` clears) / delete |
| GET | `/api/workflows/:id/versions[/:versionId]` | Version history / one version's graph |
| POST | `/api/workflows/:id/versions/:versionId/restore` | Save an old graph as the newest version |
| GET | `/api/workflows/:id/export` | Portable JSON (`flow-workflow@1`) |
| POST | `/api/workflows/import` | Create from an export; unknown credential references are dropped |
| POST, DELETE | `/api/workflows/:id/test-webhook` | Listen on / stop `/webhook-test/<path>` |
| ANY | `/webhook-test/<path>` | One test request while the editor listens |
| POST | `/api/workflows/:id/run` | Queue a run (202). `?wait=true` responds when finished (200, up to 60s). Body `{ input?, startNodeId?, destinationNodeId?, runFromNodeId?, sourceExecutionId? }` |
| GET | `/api/executions?workflowId=&status=` | Execution history |
| GET | `/api/executions/:id` | Execution with per-node output |
| POST | `/api/executions/:id/cancel` | Cancel a queued/running execution (409 if finished) |
| GET | `/api/binary-data/:id` | Download a stored file (`?download=true` for attachment) |
| GET | `/api/expressions/reference` | Variables, functions, methods (editor autocomplete) |
| POST | `/api/expressions/evaluate` | Evaluate `{ expression, json?, nodes?, itemIndex? }` → `{ value }` |
| GET | `/api/credential-types` | Credential type descriptions |
| GET, POST | `/api/credentials` | List (`?type=`) / create |
| GET, PUT, DELETE | `/api/credentials/:id` | Read (no secrets) / update (merge) / delete |
| ANY | `/webhook/<path>` | Webhook triggers of active workflows |
| GET | `/api/health`, `/api/health/ready` | Liveness / readiness (DB, Redis, S3) |

### Expressions

Parameters may contain `{{ }}`. The language is a small JS-like subset that is interpreted, not `eval`'d: it has no access to globals, prototypes or arbitrary functions, and work and result size are capped.

```
{{ $json.price * 1.2 }}                         + - * / %  < <= > >=  == != (loose)  === !== (deep)
{{ $json.age >= 18 ? "adult" : "minor" }}       && || ?? !  a ? b : c
{{ $json.name.trim().toUpperCase() }}           string / number / array methods (whitelist)
{{ $json.items.filter(i => i.qty > 0).map(i => i.sku).join(", ") }}
{{ round(sum($json.items.map(i => i.price)), 2) }}
{{ formatDate(dateAdd($now, 1, "days"), "yyyy-MM-dd") }}
{{ $node["HTTP Request"].json.id }}   {{ $binary.data.fileName }}   {{ $workflow.name }}
```

`GET /api/expressions/reference` lists everything available. A parameter that is exactly one expression keeps its type (number, array, ...), otherwise the result is interpolated as text.

### Webhook responses

| Respond mode | Response |
|---|---|
| `onReceived` (default) | `202 { executionId }` |
| `lastNode` | `200` + first item of the last executed node. `500` if the run failed. `202` if it did not finish within 30s |

The trigger item is `{ method, path, headers, query, body }`. Uploaded files are in its `binary`: multipart parts by field name, or a raw body as `data`. The size limit is `BINARY_MAX_BYTES`, and larger uploads get 413.

### Realtime events

```ts
const socket = io('http://localhost:3000/executions');
await socket.emitWithAck('subscribe', { workflowId });  // or { executionId }
socket.on('execution-event', (e) => { /* see src/modules/events/execution-events.ts */ });
```

Events: `execution.queued`, `execution.started`, `node.started`, `node.finished` (status and item counts, no data), `execution.finished`. Fetch `GET /api/executions/:id` for node output.

## Nodes

| Group | Nodes |
|---|---|
| Triggers | Manual Trigger, Webhook, Schedule, Error Trigger, Execute Workflow Trigger |
| Flow | If, Switch (one output per rule, optional fallback), Merge (append / by position / join by field / choose input), Execute Workflow, Wait |
| Transform | Set, Filter, Split Out, Aggregate, Sort, Limit, Remove Duplicates |
| Actions | HTTP Request (auth credentials, files in and out), Respond to Webhook |

- **Execute Workflow** runs another workflow that starts with an Execute Workflow Trigger. It can run once, once per item, or **once per batch**. Batches are how loops are expressed, so the graph stays acyclic. Waited sub-runs execute inside the caller's job, are recorded with `parentExecutionId`, stop when the caller is canceled or times out, and can be nested 10 levels deep.
- **Wait** sleeps in the worker for up to 65 seconds. Longer waits pause the run: the status becomes `waiting`, node outputs are stored in `wait_state`, and a delayed BullMQ job resumes it, even days later and on any worker. Overdue waits are re-scheduled on worker start and hourly. Waiting runs can be canceled.
- **Respond to Webhook** answers a Webhook trigger set to "Using a Respond to Webhook node" with a status, headers, and JSON, text or a file. The workflow continues after the response.

## Writing a node

```ts
export const myNode: NodeType = {
  description: {
    type: 'acme.doThing', version: 1, displayName: 'Do Thing', description: '...',
    group: 'action', inputs: 1, outputs: ['main'],
    credentials: [{ type: 'httpBearerAuth', required: true }],
    properties: [{ name: 'text', displayName: 'Text', type: 'string', default: '' }],
  },
  async execute(ctx) {
    const { token } = await ctx.getCredentials<{ token: string }>('httpBearerAuth');
    return [ctx.getInputItems().map((item, i) => ({
      json: { ...item.json, text: ctx.getParameter<string>('text', i) },
    }))];
  },
};
```

Register it in `src/nodes/index.ts`. Parameters arrive with expressions already resolved per item. The node's credential is selected in the graph as `node.credentials = { httpBearerAuth: '<credential id>' }`.
