<!-- fleet-commander v0.0.22 -->
# C# / .NET Conventions

> Applies to: `*.cs`, `*.csproj`, `Directory.Build.props`
> Last updated: 2026-03-18

## Architecture

C# projects typically follow a layered or DDD architecture. Read the solution
structure (`.sln` and `.csproj` files) to understand the layers before making
changes.

Common layer patterns:

```
Domain/           -- Entities, value objects, aggregates, domain events, interfaces
Application/      -- Use cases, commands, queries, DTOs, service interfaces
Infrastructure/   -- Database, external APIs, file system, DI registration
Api/ or Web/      -- Controllers, middleware, filters, model binding, startup
Tests/            -- Unit, integration, and E2E test projects
```

Each layer depends only on layers above it in the list (Domain has zero
dependencies; Api depends on everything).

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Classes | PascalCase, noun | `OrderService`, `CustomerRepository` |
| Interfaces | `I` prefix + PascalCase | `IOrderRepository`, `IEmailSender` |
| Methods | PascalCase, verb | `GetOrderById`, `CalculateTotal` |
| Async methods | suffix `Async` | `GetOrderByIdAsync` |
| Private fields | `_camelCase` | `_orderRepository`, `_logger` |
| Parameters | camelCase | `orderId`, `cancellationToken` |
| Constants | PascalCase | `MaxRetryCount`, `DefaultTimeout` |
| Namespaces | match folder path | `Company.Project.Domain.Orders` |

## Patterns to Follow

### Dependency injection

All services are registered in the DI container. Never use `new` for injected
dependencies. Constructor injection is the default:

```csharp
public class OrderService
{
    private readonly IOrderRepository _orderRepository;
    private readonly ILogger<OrderService> _logger;

    public OrderService(IOrderRepository orderRepository, ILogger<OrderService> logger)
    {
        _orderRepository = orderRepository;
        _logger = logger;
    }
}
```

Register services with the appropriate lifetime:
- `Singleton` -- stateless services, configuration, caches
- `Scoped` -- per-request services, DbContext, unit of work
- `Transient` -- lightweight, stateless, no shared state

### Entity Framework Core

- Create migrations with `dotnet ef migrations add {Name}` -- never edit
  generated migration files.
- Use `IQueryable` in repositories, materialize with `ToListAsync()` at the
  application layer.
- Configure entities in separate `IEntityTypeConfiguration<T>` classes, not
  in `OnModelCreating`.
- Always use `async` variants: `SaveChangesAsync`, `ToListAsync`, `FirstOrDefaultAsync`.

### Async/await

- Use `async/await` consistently. Never call `.Result` or `.Wait()` on hot
  paths -- it causes thread pool starvation.
- Accept `CancellationToken` in all async public methods and pass it through.
- `ConfigureAwait(false)` in library code; omit in ASP.NET controller code.

### DDD patterns (when the project uses them)

- **Aggregates**: encapsulate invariants. External code accesses child entities
  only through the aggregate root.
- **Value Objects**: immutable, compared by value. Use records or override
  `Equals`/`GetHashCode`.
- **Domain Events**: raise events from aggregates, handle in application layer.
- **Repositories**: one per aggregate root. Return domain entities, not DTOs.

## Anti-Patterns to Avoid

### Anemic domain model

Do not put all business logic in services while entities are just data bags.
If the project uses DDD, entities should enforce their own invariants:

```csharp
// WRONG -- logic in service
service.ShipOrder(order);
order.Status = OrderStatus.Shipped;

// RIGHT -- logic in entity
order.Ship(); // internally validates and sets status
```

### Service locator

Never resolve services from `IServiceProvider` directly in business logic.
Use constructor injection. The service locator pattern hides dependencies and
makes testing difficult.

### Catching Exception base type

Do not catch `Exception` generically unless you are at an application boundary
(global error handler, middleware). Catch specific exception types:

```csharp
// WRONG
try { ... } catch (Exception ex) { _logger.LogError(ex, "Failed"); }

// RIGHT
try { ... } catch (OrderNotFoundException ex) { return NotFound(); }
```

### Magic strings

Use constants, enums, or strongly-typed IDs instead of string literals for
status codes, configuration keys, or identifiers.

## Dependencies & Imports

- Use the project's C# version and nullable reference type settings.
- Add `using` directives at the top of the file, organized: System, third-party,
  project namespaces.
- Do not add NuGet packages without confirming they are needed for the task.
- When adding a NuGet package, add it to the correct `.csproj` (not the solution root
  unless it is a shared dependency).

## Testing

- **Framework**: Match the project (xUnit, NUnit, MSTest).
- **Mocking**: Use Moq, NSubstitute, or FakeItEasy -- whichever the project uses.
- **Integration tests**: Use `WebApplicationFactory<T>` for ASP.NET API tests.
- **Naming**: `MethodName_Condition_ExpectedResult` or the project's existing convention.
- **Arrange-Act-Assert**: Structure every test with clear AAA sections.
- Run `dotnet test` and fix all failures before committing.

## Build & Run

```bash
dotnet build           # Compile the solution
dotnet test            # Run all tests
dotnet run --project {ProjectName}  # Run a specific project
```

Check `Directory.Build.props` for shared build settings (nullable, implicit
usings, target framework) before adding project-level overrides.

## Common Pitfalls

### Nullable reference types

If the project has `<Nullable>enable</Nullable>`, treat all warnings as errors.
Do not suppress with `!` (null-forgiving operator) unless you can prove the
value is never null at that point.

### EF Core migration conflicts

When working on a branch, another branch may have added a migration. After
rebase, if the model snapshot conflicts, delete your migration and recreate it
against the rebased model state. Never merge migration snapshot files manually.

### Async void

Never use `async void` except for event handlers. It swallows exceptions and
cannot be awaited. Use `async Task` for all async methods.

### IDisposable leaks

If you create a disposable resource (HttpClient, Stream, DbConnection), ensure
it is disposed via `using` statement or DI container lifetime management. Prefer
`IHttpClientFactory` over `new HttpClient()`.
