<!-- fleet-commander v0.0.12 -->
# API Design Conventions

> Applies to: REST API route handlers, request/response schemas, middleware
> Last updated: 2026-03-18

## REST Conventions

### HTTP Methods

| Method | Use | Idempotent |
|--------|-----|-----------|
| `GET` | Retrieve resource(s) | Yes |
| `POST` | Create a resource or trigger an action | No |
| `PUT` | Replace a resource entirely | Yes |
| `PATCH` | Partially update a resource | No |
| `DELETE` | Remove a resource | Yes |

### Resource Naming

- Use plural nouns for collections: `/teams`, `/projects`, `/events`.
- Use the resource ID for individual items: `/teams/42`, `/projects/7`.
- Nest sub-resources when there is a clear parent-child relationship:
  `/teams/42/events`, `/projects/7/teams`.
- Avoid verbs in URLs -- use HTTP methods to express the action:
  `POST /teams/42/stop` (action) is acceptable; `GET /getTeamById` is not.

### Status Codes

| Code | When to use |
|------|------------|
| `200` | Successful GET, PUT, PATCH, DELETE |
| `201` | Successful POST that created a resource (include `Location` header) |
| `204` | Successful DELETE with no response body |
| `400` | Invalid request (missing fields, wrong types, validation failure) |
| `404` | Resource not found |
| `409` | Conflict (duplicate, state violation) |
| `422` | Semantically invalid request (valid JSON but business rule violation) |
| `500` | Unexpected server error |

## Error Responses

Use a consistent error response format across all endpoints:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description of what went wrong",
    "details": [
      { "field": "issueNumber", "message": "Must be a positive integer" }
    ]
  }
}
```

Rules:
- Always return JSON for errors, never plain text or HTML.
- Include a machine-readable `code` (for client error handling) and a
  human-readable `message` (for debugging).
- Include `details` array for validation errors with per-field messages.
- Never expose stack traces, internal paths, or database errors to clients.

## Pagination

### Cursor-based (preferred)

Use cursor-based pagination for large or frequently updated collections:

```
GET /events?cursor=eyJpZCI6MTAwfQ&limit=50

Response:
{
  "data": [...],
  "cursor": {
    "next": "eyJpZCI6MTUwfQ",
    "hasMore": true
  }
}
```

### Offset/limit (simple cases)

Acceptable for small, stable collections:

```
GET /teams?offset=20&limit=10

Response:
{
  "data": [...],
  "total": 85,
  "offset": 20,
  "limit": 10
}
```

Always enforce a maximum limit (e.g., 100) to prevent clients from requesting
unbounded result sets.

## Input Validation

- Validate all input at the API boundary -- do not trust client data.
- Return `400` with clear error messages for invalid input.
- Use the framework's schema validation (Fastify JSON Schema, Pydantic,
  FluentValidation, Zod) rather than manual validation.
- Validate types, ranges, required fields, and string formats.
- Sanitize strings to prevent injection attacks (SQL, command, XSS).

## Versioning

When the project requires API versioning:

- URL prefix is the simplest approach: `/api/v1/teams`, `/api/v2/teams`.
- Accept header versioning is an alternative: `Accept: application/vnd.api.v2+json`.
- Match whatever the project already uses. Do not introduce a new versioning
  scheme.

## Security

### Authentication and authorization

- Check auth on every endpoint that requires it. Do not rely on frontend-only
  protection.
- Use middleware or decorators for auth checks -- do not repeat auth logic in
  every handler.
- Return `401` for missing/invalid credentials, `403` for insufficient permissions.

### Input sanitization

- Escape or parameterize all user input before using it in SQL, shell commands,
  or HTML output.
- Validate file paths to prevent path traversal (`../../../etc/passwd`).
- Set appropriate CORS headers -- do not use `*` in production.

### Rate limiting

- Apply rate limits to public-facing endpoints to prevent abuse.
- Use the framework's rate limiting middleware when available.
- Return `429 Too Many Requests` with a `Retry-After` header.

## Common Pitfalls

### Inconsistent response shapes

Every endpoint should return the same shape for success responses (e.g., always
wrap in `{ "data": ... }`) and the same shape for errors. Inconsistency makes
client code fragile.

### Missing content-type headers

Always set `Content-Type: application/json` for JSON responses. Frameworks
usually handle this, but verify when returning manual responses.

### Leaking internal errors

A 500 response should return a generic error message to the client and log the
full error server-side. Never return database error messages, stack traces, or
internal file paths in API responses.
