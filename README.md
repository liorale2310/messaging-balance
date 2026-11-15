# Messaging balance

Credit-accounting core for prepaid message campaigns. Customers buy credit in orders and spend it by scheduling campaigns. This service decides what is available, what is reserved, and what the customer is told when a campaign cannot be sent. It does not expose an HTTP API, and it does not talk to the delivery provider.

## Prerequisites

- Node.js 26
- Docker, for PostgreSQL 16

## Database

Copy the example environment and start Postgres:

```bash
cp .env.example .env
docker compose up -d
```

`docker-compose.yml` reads `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, and `DB_PORT` from `.env`. The development database name is `messaging_balance`.

Schema changes are TypeORM migrations in `src/migrations`. `synchronize` is off. Apply migrations with:

```bash
npm run migration:run
```

Other migration commands:

```bash
npm run migration:show
npm run migration:revert
npm run migration:generate -- src/migrations/DescriptiveName
```

`src/database/data-source.ts` loads `.env` and is the datasource those commands use. Do not point a migration command at the test database by accident. Set `DB_NAME` only for the test script below.

## Tests

Unit tests do not need a database:

```bash
npm test
```

Database tests run against PostgreSQL and refuse to start unless `DB_NAME` ends with `_test`. Create that database once, then run the suite:

```bash
docker exec messaging-balance-postgres psql -U messaging_balance -d messaging_balance -c 'CREATE DATABASE messaging_balance_test'
DB_NAME=messaging_balance_test npm run test:db
```

The database test runner applies migrations in global setup and truncates the accounting tables between cases. The `_test` suffix is what keeps that truncate off the development database.

## Code map

`AccountingService` is the only transaction boundary. Each use case locks the customer first, then that customer's orders, campaigns, and messages, writes the change, and checks that credit still adds up before the transaction commits.

- `src/accounting/domain/allocation.policy.ts` splits free credit oldest-first and covers unbacked in-flight messages, then the earliest scheduled shortfall, then the oldest debt.
- `src/accounting/domain/handoff.policy.ts` decides whether a dispatcher report is a replay, a conflict, a stored older sequence, or the result to apply. Sequences are `bigint`.
- `src/accounting/domain/balance.projection.ts` reads the current rows into available, reserved, consumed, debt, and the sentences returned with the balance.
- `src/accounting/entities` is the schema. `src/migrations` is the only way that schema changes.

## Build

```bash
npm run build
npm run lint
```
