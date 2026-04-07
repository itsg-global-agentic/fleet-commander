<!-- fleet-commander v0.0.19 -->
# SQL & Database Conventions

> Applies to: `*.sql`, migration files, ORM model definitions, database access code
> Last updated: 2026-03-18

## Migration Discipline

- Always use the project's migration framework (Alembic, Django migrations,
  EF Core migrations, Flyway, Knex, Prisma). Never run raw DDL against production.
- Migrations must be reversible -- provide both up and down operations.
- Never edit a migration that has already been applied to any environment.
- Test migrations against a fresh database to catch ordering issues.
- After rebase, if migration files conflict, delete yours and regenerate against
  the rebased model state. Never manually merge migration files.

## Schema Conventions

### Naming

| Element | Convention | Example |
|---------|-----------|---------|
| Tables | snake_case, plural | `orders`, `pull_requests`, `usage_snapshots` |
| Columns | snake_case | `created_at`, `issue_number`, `ci_status` |
| Primary keys | `id` (integer auto-increment or UUID) | `id INTEGER PRIMARY KEY` |
| Foreign keys | `{referenced_table_singular}_id` | `team_id`, `project_id` |
| Indexes | `idx_{table}_{columns}` | `idx_events_team_id_created_at` |
| Boolean columns | `is_` or `has_` prefix | `is_active`, `has_hooks` |
| Timestamp columns | `_at` suffix | `created_at`, `merged_at`, `stopped_at` |

### Required columns

Every table should have:
- A primary key (`id`)
- `created_at` timestamp (set on insert, never updated)
- `updated_at` timestamp (set on insert, updated on every modification) -- optional
  for append-only tables like events or logs

## Query Optimization

### Avoid N+1 queries

Never fetch a list of items and then query related data in a loop. Use JOINs,
subqueries, or the ORM's eager loading:

```sql
-- WRONG: N+1
SELECT * FROM teams;
-- then for each team:
SELECT * FROM events WHERE team_id = ?;

-- RIGHT: single query
SELECT t.*, e.* FROM teams t
LEFT JOIN events e ON e.team_id = t.id;
```

### Index frequently filtered columns

Add indexes for columns that appear in WHERE, JOIN, ORDER BY, or GROUP BY clauses.
Foreign key columns should always be indexed.

### Use EXPLAIN

Before committing complex queries, run `EXPLAIN` (or `EXPLAIN ANALYZE`) to verify
the query plan uses indexes and does not perform full table scans on large tables.

## Transaction Safety

- Use explicit transactions for multi-step operations. Do not rely on auto-commit
  for operations that must be atomic.
- Keep transactions short -- do not hold locks while performing external API calls
  or expensive computations.
- Handle deadlocks gracefully -- retry with backoff when appropriate.

## ORM Patterns

### Lazy vs eager loading

- Use eager loading (JOINs / includes) for data you know you will need.
- Use lazy loading only when you rarely need the related data.
- Never traverse lazy relationships inside a loop -- this causes N+1.

### Connection pooling

- Use the ORM's built-in connection pool. Never open connections manually unless
  the framework requires it.
- Set pool size appropriate for the workload. For SQLite, a pool size of 1 is
  typical (single-writer constraint).

## SQLite-Specific

When working with SQLite (better-sqlite3 or similar):

- Enable WAL mode for concurrent reads: `PRAGMA journal_mode=WAL;`
- Use synchronous API -- better-sqlite3 is synchronous by design. Do not wrap
  calls in async wrappers unnecessarily.
- SQLite has no native DATETIME type -- store timestamps as ISO 8601 strings
  or Unix epoch integers. Be consistent within the project.
- Use `INSERT OR REPLACE` or `ON CONFLICT` for upserts.
- Foreign keys are off by default -- ensure `PRAGMA foreign_keys = ON` is set
  at connection time.

## Common Pitfalls

### String interpolation in queries

Never interpolate user input into SQL strings. Always use parameterized queries:

```sql
-- WRONG (SQL injection risk)
SELECT * FROM users WHERE name = '${userName}';

-- RIGHT (parameterized)
SELECT * FROM users WHERE name = ?;
```

### Missing NOT NULL constraints

Default to `NOT NULL` for all columns unless NULL has a meaningful semantic
(e.g., `stopped_at` is NULL while a team is still running). Nullable columns
require NULL checks everywhere they are used.

### Large transactions in SQLite

SQLite uses a single-writer model. Long-running write transactions block all
other writers. Keep write transactions as short as possible.
