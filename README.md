# Flow Platform — backend

Workflow automation backend (n8n-style): NestJS 12, TypeORM + PostgreSQL, BullMQ + Redis, socket.io.

## Getting started

```bash
cp .env.example .env
# set ENCRYPTION_KEY in .env: openssl rand -base64 32
docker compose up -d              # Postgres on :5440, Redis on :6390
npm install
npm run start:dev                 # APP_ROLE=all: API + worker in one process; migrations run on startup
```

- API: http://localhost:3000/api
- Swagger UI: http://localhost:3000/docs (OpenAPI JSON at `/docs/openapi.json`; the frontend generates its types from it)
- Webhooks: http://localhost:3000/webhook/&lt;path&gt;
- WebSocket: socket.io namespace `/executions`

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

## How it works

- **Runs** are rows in `executions` (status `queued → running → success|error`) plus one `execution_steps` row per executed node. The queue only carries the execution id. A worker claims a run with a conditional `UPDATE ... WHERE status = 'queued'`, so a duplicated job cannot execute twice.
- **No automatic retries.** Jobs have `attempts: 1` and `maxStalledCount: 0`, because nodes may have side effects. If a worker dies mid-run, the run is marked `error` and is not re-run.
- **Activation** (`PUT /api/workflows/:id { active: true }`) registers the workflow's triggers:
  - **Webhook nodes** get rows in the `webhooks` table, written in the same transaction as the workflow save. Path conflicts return 409 and roll back the save.
  - **Schedule nodes** become BullMQ job schedulers in Redis (`schedule:<workflowId>:<nodeId>`). On startup the schedulers are reconciled against active workflows, and a worker that fires a stale scheduler removes it.
  - **Saving** an active workflow re-syncs its triggers. **Deactivating** or **deleting** it removes them.
- **Credentials** are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. The API never returns fields marked `secret`. `PUT` merges data, so omitted fields keep their stored values. If the key is lost, stored credentials become unreadable.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Unit tests (engine, nodes, cipher; no DB) |
| `npm run test:e2e` | Full-stack tests; needs `docker compose up -d` and `.env` |
| `npm run migration:generate src/database/migrations/<Name>` | Diff entities against the DB and write a migration |
| `npm run migration:run` / `migration:revert` | Apply / roll back migrations |

New migrations must be added to `src/database/migrations/index.ts`. Entities and migrations are listed explicitly because glob paths are unreliable under ESM.

## Layout

```
src/
  engine/        Framework-free execution engine: graph types and validation,
                 expression resolver ({{ $json.x }}), WorkflowRunner
  nodes/         Built-in nodes (manualTrigger, webhook, schedule, set, if, httpRequest)
                 and credential types
  queue/         BullMQ queue name, job names and payloads
  modules/
    workflows/   CRUD; every graph change creates an immutable WorkflowVersion
    executions/  Creates queued runs, waits for them, history
    worker/      Queue processor and ExecutionExecutor (worker role only)
    triggers/    Activation: webhook routing table and cron job schedulers
    webhooks/    Public /webhook/* endpoint (api role only)
    credentials/ Encrypted credential storage
    events/      Redis pub/sub of execution progress + socket.io gateway
    node-types/  NodeRegistry + GET /api/node-types (the editor builds forms from it)
    workspaces/  Tenant boundary; a single default workspace until auth exists
  database/      TypeORM options, CLI data source, migrations
```

## API

| Method | Path | |
|---|---|---|
| GET | `/api/node-types` | Node type descriptions |
| GET, POST | `/api/workflows` | List (paginated) / create |
| GET, PUT, DELETE | `/api/workflows/:id` | Read / update (`graph` → new version, `active` → (de)activate triggers) / delete |
| GET | `/api/workflows/:id/versions` | Version history |
| POST | `/api/workflows/:id/run` | Queue a run (202). `?wait=true` responds when finished (200, up to 60s). Body `{ input?: object[], startNodeId? }` |
| GET | `/api/executions?workflowId=&status=` | Execution history |
| GET | `/api/executions/:id` | Execution with per-node output |
| GET | `/api/credential-types` | Credential type descriptions |
| GET, POST | `/api/credentials` | List (`?type=`) / create |
| GET, PUT, DELETE | `/api/credentials/:id` | Read (no secrets) / update (merge) / delete |
| ANY | `/webhook/<path>` | Webhook triggers of active workflows |
| GET | `/api/health` | DB health check |

### Webhook responses

| Respond mode | Response |
|---|---|
| `onReceived` (default) | `202 { executionId }` |
| `lastNode` | `200` + first item of the last executed node. `500` if the run failed. `202` if it did not finish within 30s |

The trigger item is `{ method, path, headers, query, body }`.

### Realtime events

```ts
const socket = io('http://localhost:3000/executions');
await socket.emitWithAck('subscribe', { workflowId });  // or { executionId }
socket.on('execution-event', (e) => { /* see src/modules/events/execution-events.ts */ });
```

Events: `execution.queued`, `execution.started`, `node.started`, `node.finished` (status and item counts, no data), `execution.finished`. Fetch `GET /api/executions/:id` for node output.

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
