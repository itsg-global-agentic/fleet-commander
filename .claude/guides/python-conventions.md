<!-- fleet-commander v0.0.19 -->
# Python Conventions

> Applies to: `*.py`, `pyproject.toml`, `requirements.txt`, `setup.cfg`
> Last updated: 2026-03-18

## Architecture

Python projects vary widely. Read `CLAUDE.md` and the project's entry point to
understand the framework and structure before making changes.

Common patterns:

```
src/
  app/            -- Application code
    models/       -- Database models / domain entities
    services/     -- Business logic
    api/          -- Route handlers / views
    schemas/      -- Pydantic models / serializers
  tests/          -- Test files (mirror src structure)
  migrations/     -- Database migrations (Alembic / Django)
```

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Modules | snake_case | `order_service.py`, `user_repository.py` |
| Classes | PascalCase | `OrderService`, `UserRepository` |
| Functions | snake_case | `get_order_by_id`, `calculate_total` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRIES`, `DEFAULT_TIMEOUT` |
| Private | underscore prefix | `_validate_input`, `_cache` |
| Type variables | single uppercase or descriptive | `T`, `ReturnType` |

## Patterns to Follow

### Type hints

Add type hints to all new function signatures. Use `typing` module types for
complex signatures:

```python
from typing import Optional, Sequence

def get_orders(user_id: int, limit: Optional[int] = None) -> Sequence[Order]:
    ...
```

### Framework patterns

- **Django**: Use class-based views when they fit, function-based for simple endpoints.
  Create migrations with `makemigrations` -- never edit migration files manually.
- **Flask**: Use blueprints for route organization. Register extensions in the
  application factory.
- **FastAPI**: Use Pydantic models for request/response schemas. Use dependency
  injection for services and database sessions.

### Async patterns

- Use `async/await` with asyncio when the framework supports it (FastAPI, aiohttp).
- Use `async with` for context managers that manage connections or sessions.
- Do not mix sync and async code without explicit bridges (`asyncio.to_thread`
  for sync-in-async, `asyncio.run` for async-in-sync at boundaries only).

## Anti-Patterns to Avoid

### Mutable default arguments

```python
# WRONG -- shared mutable default
def add_item(item: str, items: list[str] = []) -> list[str]:
    items.append(item)
    return items

# RIGHT -- use None sentinel
def add_item(item: str, items: list[str] | None = None) -> list[str]:
    if items is None:
        items = []
    items.append(item)
    return items
```

### Bare except clauses

Never catch `Exception` or use bare `except:` unless you are at an application
boundary (middleware, CLI entry point). Catch specific exception types.

### os.path for file operations

Prefer `pathlib.Path` over `os.path` for all file operations:

```python
# Prefer
from pathlib import Path
config_path = Path("config") / "settings.json"

# Avoid
import os
config_path = os.path.join("config", "settings.json")
```

## Dependencies & Imports

- Activate the project's virtualenv before running any Python commands.
- Import order: stdlib, third-party, local (match existing style or use isort).
- Do not add packages without confirming they are needed for the task.
- Check for the project's dependency tool: `requirements.txt`, `pyproject.toml`,
  `poetry`, or `uv`.

## Testing

- **Framework**: pytest (fixtures, parametrize, conftest) or unittest -- match the project.
- **Naming**: `test_function_name_condition_expected_result` or the project's convention.
- **Fixtures**: Use `conftest.py` for shared fixtures. Prefer fixture factories
  over complex fixture chains.
- **Parametrize**: Use `@pytest.mark.parametrize` for testing multiple inputs.
- **Mocking**: Use `unittest.mock.patch` or `monkeypatch` -- mock at boundaries only.
- Run `pytest` (or project-specific command) and fix all failures before committing.

## Build & Run

```bash
python -m pytest          # Run tests
python -m mypy .          # Type check (if project uses mypy)
python -m black --check . # Format check (if project uses black)
pip install -e .          # Install in development mode
```

## Common Pitfalls

### Import errors from circular dependencies

Python resolves imports at module load time. Circular imports cause
`ImportError` or `AttributeError`. Fix by moving shared types to a separate
module or using `TYPE_CHECKING` guards for type-only imports.

### Django migration conflicts after rebase

If another branch added a migration, yours may conflict. Delete your migration
and recreate with `python manage.py makemigrations`. Never manually merge
migration files.

### Forgetting to close resources

Use context managers (`with` statements) for files, database connections, and
HTTP sessions. Do not rely on garbage collection to close resources.
