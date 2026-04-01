<!-- fleet-commander v0.0.17 -->
# DevOps / Infrastructure Conventions

> Applies to: `.github/workflows/*.yml`, `Dockerfile`, `docker-compose.yml`, `*.sh`, `*.ps1`, `Makefile`
> Last updated: 2026-03-18

## Architecture

Infrastructure code typically lives in these locations:

```
.github/workflows/   -- GitHub Actions CI/CD pipelines
docker/              -- Dockerfiles and compose files (or project root)
scripts/             -- Build, deploy, and utility scripts
k8s/ or deploy/      -- Kubernetes manifests, Helm charts
infra/               -- Terraform, Pulumi, or other IaC
```

Read `CLAUDE.md` and existing CI config before making changes. Match the project's
existing patterns for pipeline structure, script conventions, and deployment approach.

## CI/CD — GitHub Actions

### Pinned versions

Always use pinned action versions, not `@main` or floating tags:

```yaml
# RIGHT
uses: actions/checkout@v4
uses: actions/setup-node@v4

# WRONG
uses: actions/checkout@main
```

### Permissions block

Set explicit `permissions` on every workflow. Use least-privilege:

```yaml
permissions:
  contents: read
  pull-requests: write
```

### Matrix strategies

Use matrices for multi-version testing. Include `fail-fast: false` when you want
all combinations to run:

```yaml
strategy:
  fail-fast: false
  matrix:
    node-version: [18, 20, 22]
    os: [ubuntu-latest, windows-latest]
```

### Secrets

- Never hardcode secrets in workflows -- use `${{ secrets.NAME }}`.
- Never echo or log secret values.
- Use environment-level secrets for deployment-specific values.

## Docker

### Multi-stage builds

Use multi-stage builds to minimize image size:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
```

### Layer caching

Order Dockerfile instructions from least-changing to most-changing. Copy
dependency files before source code so dependency installation is cached.

### .dockerignore

Always maintain a `.dockerignore` file. Include at minimum:
`node_modules`, `.git`, `*.md`, `tests/`, `.env*`.

## Scripts

### Cross-platform compatibility

When the project supports both Windows and Linux:

- Provide both `.sh` and `.ps1` versions, or use a tool that runs on both (Node.js, Python).
- Use forward slashes in paths within scripts -- bash on Windows handles them.
- Avoid platform-specific commands without alternatives (`sed` on Windows needs Git Bash).
- Ensure shell scripts use LF line endings -- CRLF breaks shebang lines on Linux.

### Idempotency

Scripts must be safe to run multiple times. Check for existing state before
creating resources:

```bash
# RIGHT -- idempotent
mkdir -p "$TARGET_DIR"
[ -f "$CONFIG" ] || cp template.conf "$CONFIG"

# WRONG -- fails on second run
mkdir "$TARGET_DIR"
cp template.conf "$CONFIG"
```

### Error handling

Use `set -euo pipefail` in bash scripts. Check exit codes for critical operations.

## Anti-Patterns to Avoid

### Hardcoded paths and URLs

Never hardcode environment-specific values. Use environment variables or
configuration files:

```bash
# WRONG
curl https://api.prod.example.com/deploy

# RIGHT
curl "${DEPLOY_URL}/deploy"
```

### Skipping YAML validation

Always validate YAML syntax before committing pipeline changes. A typo in a
workflow file can break CI for the entire team.

### Database migrations without rollback

Database migrations must be reversible. Always provide a down/rollback migration.
Test migrations against a fresh database to catch ordering issues.

## Testing Infrastructure Changes

- **GitHub Actions**: Use `act` for local testing when possible, or create a
  draft PR to trigger the workflow.
- **Docker**: Build and run locally before pushing. Test with `docker build --no-cache`.
- **Scripts**: Run scripts in a clean environment to verify they work without
  pre-existing state.

## Build & Run

```bash
# GitHub Actions
act -j build                    # Run locally with act
gh workflow run ci.yml          # Trigger manually

# Docker
docker build -t app:test .      # Build image
docker compose up -d            # Start services

# Scripts
bash scripts/install.sh         # Run install script
shellcheck scripts/*.sh         # Lint shell scripts
```

## Common Pitfalls

### GitHub Actions caching

Cache keys must include the lockfile hash. Stale caches cause mysterious build
failures. Use `hashFiles('**/package-lock.json')` or equivalent.

### Docker build context size

A missing `.dockerignore` sends the entire repo (including `node_modules` and
`.git`) as build context, making builds slow. Check context size if builds are
unexpectedly slow.

### Script encoding on Windows

Git on Windows may convert LF to CRLF. Bash scripts with CRLF line endings fail
with cryptic errors (`$'\r': command not found`). Use `.gitattributes` to force
LF for shell scripts: `*.sh text eol=lf`.
