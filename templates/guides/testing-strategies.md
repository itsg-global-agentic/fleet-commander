<!-- fleet-commander v0.0.13 -->
# Testing Strategies

> Applies to: all test files regardless of language or framework
> Last updated: 2026-03-18

## Test Pyramid

Prioritize tests in this order:

1. **Unit tests** -- fast, isolated, test a single function or class. Bulk of
   your test suite.
2. **Integration tests** -- test interactions between components (API routes +
   database, service + external client). Fewer than unit tests.
3. **E2E tests** -- test critical user flows through the full stack. Fewest
   tests, longest to run.

## Unit Tests

- Test one thing per test. If a test name contains "and", split it.
- Fast and isolated -- no network, no filesystem, no database (unless testing
  database code specifically).
- Mock external dependencies only -- do not mock the code under test or
  internal collaborators unless necessary for isolation.
- Test behavior, not implementation. Assert on outputs and side effects, not
  on how the function achieved the result.

## Integration Tests

- Hit a real database when possible. Mocked database tests have failed to catch
  real issues (migration failures, constraint violations, query behavior
  differences).
- Test API endpoints end-to-end: send HTTP request, assert response status,
  headers, and body.
- Use test fixtures or factories to set up required data. Clean up after each
  test (transaction rollback or truncation).
- Acceptable to be slower than unit tests, but still aim for seconds, not minutes.

## E2E Tests

- Test critical user flows only -- login, main workflow, key error paths.
- Use Playwright, Cypress, or similar browser automation tools.
- Keep E2E tests stable: use data-testid attributes for selectors, not CSS
  classes or text content that changes frequently.
- Run E2E tests in CI but not on every commit -- on PR or nightly is sufficient.

## Test Naming

Use descriptive names that explain the scenario and expected outcome:

```
describe('OrderService')
  it('should calculate total with tax for US orders')
  it('should throw when order has no items')
  it('should apply discount when coupon is valid')
```

Naming patterns by framework:
- **Jest/Vitest**: `describe('ClassName')` / `it('should do X when Y')`
- **pytest**: `test_function_name_condition_expected_result`
- **xUnit/NUnit**: `MethodName_Condition_ExpectedResult`
- **Expecto**: backtick names: `` let `calculate total returns zero for empty list` ``

Always match the project's existing naming convention.

## Mocking

### Mock at boundaries, not internals

Boundaries to mock:
- External HTTP APIs (third-party services, GitHub API)
- File system (when testing logic, not file operations)
- Time/date (use injectable clocks)
- Random number generators

Do not mock:
- Internal functions or methods of the code under test
- Database access in integration tests (use a real test database)
- Framework internals (let the framework do its job)

### Prefer fakes over mocks when possible

A fake is a working implementation with simplified behavior (in-memory database,
stub HTTP server). Fakes are more realistic than mocks and catch more bugs.

## Coverage

- Aim for meaningful coverage, not 100%. Test behavior, not lines.
- Focus coverage on: business logic, error paths, edge cases, security-sensitive code.
- Do not write tests just to increase coverage numbers. Tests that assert
  trivial behavior (getters, constructors) add maintenance cost without value.
- Missing coverage in error paths and edge cases is more dangerous than missing
  coverage in happy paths.

## Test Organization

- Mirror the source file structure in the test directory.
- Colocate test utilities and fixtures near the tests that use them.
- Share test helpers via a common `conftest.py`, `test-utils.ts`, or equivalent.
- Do not share state between tests -- each test should be independent and
  runnable in isolation.

## Common Pitfalls

### Flaky tests

Tests that sometimes pass and sometimes fail erode trust in the test suite.
Common causes: shared state between tests, time-dependent assertions, race
conditions in async code, external service dependencies.

Fix: isolate tests, use deterministic time, mock external services, add retries
only as a last resort (with a comment explaining why).

### Testing implementation details

Tests that assert on internal method calls or private state break when you
refactor, even if behavior is preserved. Test the public API and observable
effects instead.

### Ignoring test failures

Never skip or disable a failing test without understanding why it fails. A
skipped test is invisible technical debt. If a test is genuinely obsolete,
delete it entirely.
