<!-- fleet-commander v0.0.22 -->
# F# Conventions

> Applies to: `*.fs`, `*.fsi`, `*.fsx`, `*.fsproj`
> Last updated: 2026-03-18

## Architecture

F# projects use a layered module structure. Files compile top-to-bottom in the
order listed in the `.fsproj` file. This is enforced by the compiler -- there is
no way around it.

Typical layer ordering (top of .fsproj = compiled first):

```
Domain.Types.fs         -- Discriminated unions, value objects, domain types
Domain.Events.fs        -- Domain events
Domain.Services.fs      -- Pure domain logic, no IO
Application.Commands.fs -- Use-case orchestration
Application.Queries.fs  -- Read-side projections
Infrastructure.Db.fs    -- Database access (side effects live here)
Api.Handlers.fs         -- HTTP handlers (thin, delegate to Application)
Program.fs              -- Composition root, DI wiring, app startup (always last)
```

Each file can only reference types and functions defined in files listed above it.

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Modules | PascalCase, noun | `module OrderProcessing` |
| Functions | camelCase, verb | `let calculateTotal items = ...` |
| Types (DUs, records) | PascalCase | `type OrderStatus = Pending \| Shipped` |
| DU cases | PascalCase | `Pending`, `Shipped`, `Cancelled` |
| Parameters | camelCase | `orderId`, `customerName` |
| Private helpers | prefix with underscore or nest in local scope | `let _validate x = ...` |
| Test functions | backtick names describing behavior | `` let `calculateTotal returns zero for empty list` () = `` |

## Patterns to Follow

### Discriminated unions for domain modeling

Prefer DUs over class hierarchies. Encode business rules in the type system so
invalid states are unrepresentable:

```fsharp
type Email = private Email of string
module Email =
    let create (s: string) =
        if s.Contains("@") then Ok (Email s)
        else Error "Invalid email"
    let value (Email s) = s
```

### Railway-oriented programming

Use `Result<'T, 'E>` for operations that can fail. Chain with `Result.bind`
or a `result {}` computation expression:

```fsharp
let processOrder orderId =
    validateOrder orderId
    |> Result.bind checkInventory
    |> Result.bind chargePayment
    |> Result.bind shipOrder
```

### Pipeline style

Prefer pipelines over nested function calls:

```fsharp
// Good
orders
|> List.filter (fun o -> o.Status = Active)
|> List.sortBy (fun o -> o.CreatedAt)
|> List.take 10

// Avoid
List.take 10 (List.sortBy (fun o -> o.CreatedAt) (List.filter (fun o -> o.Status = Active) orders))
```

### Computation expressions

Use `async {}` for legacy async, `task {}` for .NET Task interop. Match whichever
the project already uses -- do not mix styles within a module.

```fsharp
let fetchOrder (id: OrderId) = task {
    let! result = db.QueryAsync<Order>(id)
    return result |> Option.ofObj
}
```

## Anti-Patterns to Avoid

### Mutable state in domain logic

Never use `mutable` in domain types or domain service functions. Mutation is
acceptable only in infrastructure code (e.g., filling a buffer) and must be
isolated behind a pure interface.

### Classes for domain models

Do not create classes with inheritance hierarchies for domain concepts. Use
discriminated unions and records. Classes are acceptable for infrastructure
(e.g., a repository implementation) but not for domain types.

### Ignoring Result errors

Never discard a `Result` value or convert it to an exception unless you are at
an application boundary (e.g., an HTTP handler returning 400/500):

```fsharp
// WRONG -- silently ignores failure
let _ = processOrder orderId

// RIGHT -- handle both cases
match processOrder orderId with
| Ok order -> handleSuccess order
| Error e -> handleFailure e
```

### Float/double for financial values

Never use `float` or `double` for money, prices, quantities, or financial
calculations. Use `decimal` exclusively. Floating-point rounding errors
compound silently in financial contexts.

```fsharp
// WRONG
let total: float = price * quantity

// RIGHT
let total: decimal = price * quantity
```

## Dependencies & Imports

- Open modules explicitly -- avoid `[<AutoOpen>]` on new modules unless the
  project already uses it extensively.
- Prefer `open` at the top of the file, not inside functions.
- Group opens: FSharp.Core / System first, then third-party, then project modules.
- Do not add NuGet packages without confirming they are needed for the task.

## Testing

- **Framework**: Match whatever the project uses (Expecto, xUnit+FsUnit, NUnit).
- **Property-based tests**: Use FsCheck for functions with well-defined input/output
  contracts (e.g., `serialize >> deserialize = id`).
- **Assertions**: Prefer Unquote (`test <@ expr @>`) or FsUnit matchers over
  raw `Assert.Equal` when the project supports them.
- **Test file placement**: Mirror the source file in a parallel test project.
  If source is `Domain.Orders.fs`, test is `Domain.OrdersTests.fs`.
- Run `dotnet test` and fix all failures before committing.

## Build & Run

```bash
dotnet build           # Compile -- catches type errors and .fsproj ordering issues
dotnet test            # Run all tests
dotnet run             # Run the application (if applicable)
```

Always run `dotnet build` immediately after adding a new `.fs` file to catch
compilation order errors early. If you get "not defined" or "not recognized"
errors, the problem is almost certainly file ordering in `.fsproj`.

## Common Pitfalls

### .fsproj file ordering (CRITICAL)

F# compiles files strictly top-to-bottom as listed in the `.fsproj` `<Compile>`
items. When adding a new file:

1. **Read the `.fsproj` first** -- understand the current order.
2. **Insert the new `<Compile Include="..." />` at the correct position** --
   after its dependencies, before its dependents.
3. **Run `dotnet build` immediately** -- do not write more code until the build passes.

If build fails with "The type 'X' is not defined" or "The namespace 'Y' is not
defined", check `.fsproj` order FIRST. This is the most common F# build failure.

### Module vs namespace

- `namespace Foo` -- groups types, cannot contain `let` bindings at top level.
- `module Foo` -- can contain `let` bindings, types, and nested modules.

Match whatever the project uses. Do not switch conventions within a project.

### Partial application surprises

Be explicit with parameter counts. A function `let add x y = x + y` partially
applied as `add 1` returns a function, not a value. This is correct behavior
but can surprise when passing to higher-order functions that expect a value.

### Equality semantics

F# records and DUs have structural equality by default. Classes do not. If you
wrap a class in a record, the record's equality will use reference equality for
that field. Use `[<CustomEquality; CustomComparison>]` if needed.
