# Flow Platform — backend

Workflow automation backend (n8n-style): NestJS 12, TypeORM + PostgreSQL. BullMQ + Redis arrive in v0.2.

## Getting started

```bash
cp .env.example .env
docker compose up -d postgres     # Postgres on localhost:5440
npm install
npm run start:dev                 # migrations run on startup (DB_MIGRATIONS_RUN=true)
```

- API: http://localhost:3000/api
- Swagger UI: http://localhost:3000/docs (OpenAPI JSON at `/docs/openapi.json`; the frontend generates its types from it)

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Unit tests (engine and nodes, no DB) |
| `npm run test:e2e` | API tests against the Postgres from `docker-compose.yml` |
| `npm run migration:generate src/database/migrations/<Name>` | Diff entities against the DB and write a migration |
| `npm run migration:run` / `migration:revert` | Apply / roll back migrations |

New migrations must be added to `src/database/migrations/index.ts`: entities and migrations are listed explicitly because glob paths are unreliable under ESM.

## Layout

```
src/
  engine/        Framework-free execution engine: graph types and validation,
                 expression resolver ({{ $json.x }}), WorkflowRunner
  nodes/         Built-in node types (core.manualTrigger, core.set, core.if, core.httpRequest)
  modules/
    workflows/   CRUD; every graph change creates an immutable WorkflowVersion
    executions/  Runs a workflow (in-process for now) and stores per-node steps
    node-types/  NodeRegistry + GET /api/node-types (the editor builds forms from it)
    workspaces/  Tenant boundary; a single default workspace until auth exists
  database/      TypeORM options, CLI data source, migrations
```

## API

| Method | Path | |
|---|---|---|
| GET | `/api/node-types` | Node type descriptions |
| GET, POST | `/api/workflows` | List (paginated) / create |
| GET, PUT, DELETE | `/api/workflows/:id` | Read / update (a new graph creates a new version) / delete |
| GET | `/api/workflows/:id/versions` | Version history |
| POST | `/api/workflows/:id/run` | Run synchronously; body `{ input?: object[], startNodeId? }` |
| GET | `/api/executions?workflowId=&status=` | Execution history |
| GET | `/api/executions/:id` | Execution with per-node output |
| GET | `/api/health` | DB health check |

## Writing a node

```ts
export const myNode: NodeType = {
  description: {
    type: 'acme.doThing', version: 1, displayName: 'Do Thing', description: '...',
    group: 'action', inputs: 1, outputs: ['main'],
    properties: [{ name: 'text', displayName: 'Text', type: 'string', default: '' }],
  },
  async execute(ctx) {
    return [ctx.getInputItems().map((item, i) => ({
      json: { ...item.json, text: ctx.getParameter<string>('text', i) },
    }))];
  },
};
```

Register it in `src/nodes/index.ts`. Parameters arrive with expressions already resolved per item.
