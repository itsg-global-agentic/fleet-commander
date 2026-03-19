# TypeScript / JavaScript Conventions

> Applies to: `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `package.json`, `tsconfig.json`
> Last updated: 2026-03-18

## Architecture

Read `tsconfig.json` to understand strict mode, path aliases, and module resolution
before making changes. Check `package.json` for the build tool (Vite, webpack, tsup,
esbuild) and test runner (Vitest, Jest).

Common project structures:

```
src/
  server/       -- Backend: Fastify, Express, NestJS, tRPC
  client/       -- Frontend: React, Vue, Svelte
  shared/       -- Shared types and utilities
  tests/        -- Test files (or colocated with source)
```

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Files (components) | PascalCase | `TeamDetail.tsx`, `StatusBadge.tsx` |
| Files (utilities) | camelCase or kebab-case | `useTeamData.ts`, `sse-broker.ts` |
| Interfaces/Types | PascalCase | `TeamStatus`, `PullRequest` |
| Functions | camelCase | `fetchTeams`, `calculateTotal` |
| Constants | UPPER_SNAKE_CASE or camelCase | `MAX_RETRIES`, `defaultConfig` |
| React components | PascalCase, functional only | `function TeamRow({ team }: Props)` |
| Hooks | `use` prefix | `useTeamData`, `useSSE` |

## Patterns to Follow

### TypeScript strict typing

- No `any` types -- use `unknown` + type guards, generics, or proper interfaces.
- Prefer named exports over default exports (unless project convention differs).
- Run `tsc --noEmit` to catch type errors before committing.
- Use `interface` for object shapes, `type` for unions and intersections.

### React (when applicable)

- Functional components only -- no class components.
- Hooks for state and effects: `useState`, `useEffect`, `useCallback`, `useMemo`.
- Avoid prop drilling -- use context or composition patterns.
- Use suspense boundaries for async data loading when the project supports it.

### Backend (Node.js)

- Match the project's framework: Express, Fastify, NestJS, tRPC.
- Use async/await consistently -- never mix callbacks and promises.
- Register routes and plugins following the existing project structure.
- Validate inputs at the API boundary using the framework's schema validation.

## Anti-Patterns to Avoid

### `any` type leaks

Never use `any`. If you need an escape hatch, use `unknown` with a type guard:

```typescript
// WRONG
function parse(data: any) { return data.name; }

// RIGHT
function parse(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'name' in data) {
    return (data as { name: string }).name;
  }
  throw new Error('Invalid data');
}
```

### Unnecessary re-renders (React)

Do not create new object/array/function references inside render:

```typescript
// WRONG -- creates new array every render
<List items={data.filter(x => x.active)} />

// RIGHT -- memoize
const activeItems = useMemo(() => data.filter(x => x.active), [data]);
<List items={activeItems} />
```

## Dependencies & Imports

- Use the project's package manager: check for `pnpm-lock.yaml`, `yarn.lock`,
  or `package-lock.json` and use the corresponding tool.
- Do not add npm packages without confirming they are needed for the task.
- Import order: external packages first, then internal modules, then relative imports.

## Testing

- **Framework**: Vitest or Jest -- match whichever the project uses.
- **Component tests**: Testing Library (`@testing-library/react`).
- **E2E tests**: Playwright -- use the MCP plugin for browser interaction when available.
- **Naming**: `describe('ComponentName')` / `it('should do X when Y')`.
- **Assertions**: `expect(value).toBe(expected)` -- test behavior, not implementation.
- Run the project's test command before committing.

## Build & Run

```bash
npm run build        # or pnpm/yarn -- production build
npm run dev          # development server with HMR
npm test             # run test suite
tsc --noEmit         # type-check without emitting files
```

## Common Pitfalls

### Missing dependency arrays in hooks

Always include all referenced values in `useEffect`, `useCallback`, and `useMemo`
dependency arrays. Missing dependencies cause stale closures.

### Forgetting to handle loading and error states

Every async operation needs three states: loading, success, error. Do not render
data components before the data has loaded.

### Circular imports

TypeScript allows circular imports but they cause runtime issues (undefined at
import time). If you see `undefined is not a function` or `Cannot read property
of undefined` at startup, check for circular imports.
