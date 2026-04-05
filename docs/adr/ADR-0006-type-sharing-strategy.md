# ADR-0006: Type Sharing Strategy

## Status

Proposed

## Context

Open-Kanban has two separate type definitions:
- Go types in `backend/internal/models/models.go`
- TypeScript types in `frontend/src/types/kanban.ts`

Both sets of types represent the same data models (Board, Column, Task, User, etc.) but are maintained manually in separate codebases. When the API changes, both files must be updated manually, which is error-prone and can lead to inconsistencies.

Key issues:
1. **Duplication** - Same types defined in two places
2. **Sync Risk** - Manual updates can get out of sync
3. **Inconsistency** - API responses may not match either type definition

## Decision

Use OpenAPI-based type generation for the frontend TypeScript types.

### Approach

1. **Use existing OpenAPI spec** (`docs/openapi.yaml`) as the source of truth for API types
2. **Generate TypeScript types** using `openapi-generator` (typescript-fetch template)
3. **Maintain Go types manually** since Go's strong typing provides compile-time guarantees and the backend is a single codebase
4. **Keep existing types as reference** during transition period

### Implementation

1. Add `openapi-generator-cli` as frontend dev dependency
2. Create npm script `generate:types` that runs the generator
3. Generated types placed in `frontend/src/types/generated/`
4. Frontend code imports from generated types
5. Update OpenAPI spec when API schema changes

### Alternatives Considered

1. **Protobuf** - Define types once in protobuf, generate both Go and TypeScript
   - Rejected: Requires adding protobuf dependency, more complex setup, OpenAPI already exists

2. **JSON Schema** - Use JSON Schema to define types
   - Rejected: Less mature tooling for TypeScript generation, OpenAPI is already in use

3. **Manual Sync** - Keep manual types but add strict validation
   - Rejected: Doesn't solve the root cause of duplication

## Consequences

### Positive
- Single source of truth for API types
- Auto-generated TypeScript types ensure consistency
- Easy to regenerate types when API changes
- No duplicate type maintenance for frontend

### Negative
- Generated types may need manual adjustment for edge cases
- Frontend-specific types (like `Agent` extending `User`) need custom handling
- Go backend types still manual (acceptable trade-off)

### Risks
- OpenAPI spec must be kept accurate and complete
- Generated types may have different naming conventions

## References

- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
- [openapi-generator](https://openapi-generator.tech/)
- [Type Sharing Specification](../TYPE_SHARING.md)