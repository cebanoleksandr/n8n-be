# Flow Platform — backend

Workflow automation backend (n8n-style): NestJS 12, TypeORM + PostgreSQL, BullMQ + Redis, S3-compatible object storage, socket.io.

## Getting started

```bash
cp .env.example .env
# set ENCRYPTION_KEY in .env: openssl rand -base64 32
docker compose up -d              # Postgres :5440, Redis :6390, S3 (SeaweedFS) :9010
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
- **Retries** are per node: `retryOnFail`, `maxTries` (≤ 10) and `waitBetweenTriesMs` on the graph node. `execution_steps.tries` records the attempts.
- **Timeouts and cancel** share one AbortSignal per run. The timeout is `settings.timeoutSeconds`, capped by `EXECUTION_TIMEOUT_MAX_SECONDS`, and a timed-out run ends as `error` (`ExecutionTimeoutError`). `POST /api/executions/:id/cancel` cancels a queued run directly. For a running one the API publishes a cancel request over Redis, and the worker holding the run aborts it. The runner stops between nodes, during retry waits and mid-node: it stops waiting for the node's promise even if the node ignores the signal.
- **Error workflows**: `settings.errorWorkflowId` points to a workflow with an **Error Trigger**. When a webhook or schedule run fails, that workflow is started with `{ execution: { id, mode, error, lastNodeExecuted, startedAt }, workflow: { id, name } }`. As in n8n, manual runs and failures of error workflows do not trigger it.
- **Binary data**: items carry `binary: { [field]: { id, fileName, mimeType, size } }`, and the bytes live in S3 under `<workspaceId>/<id>`, with metadata in `binary_data`. Nodes use `ctx.helpers.storeBinary/readBinary`. Webhooks store multipart files and raw non-JSON bodies (field `data`). Deleting a workflow orphans its files, and an hourly job deletes them. Any S3 service works; compose uses SeaweedFS because MinIO no longer publishes public images.
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
    binary-data/ S3 storage of item files, download endpoint, orphan cleanup
    expressions/ Autocomplete reference and live evaluation for the editor
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
| GET, PUT, DELETE | `/api/workflows/:id` | Read / update (`graph` → new version, `active` → (de)activate triggers, `settings` → `{ errorWorkflowId, timeoutSeconds }`, `null` clears) / delete |
| GET | `/api/workflows/:id/versions` | Version history |
| POST | `/api/workflows/:id/run` | Queue a run (202). `?wait=true` responds when finished (200, up to 60s). Body `{ input?: object[], startNodeId? }` |
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
| GET | `/api/health` | DB health check |

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
