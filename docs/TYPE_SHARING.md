# Type Sharing Architecture Specification

## Overview

This document describes the type sharing architecture for Open-Kanban to ensure API type consistency between frontend and backend.

## Problem Statement

Currently, TypeScript types in `frontend/src/types/kanban.ts` and Go types in `backend/internal/models/models.go` are maintained manually. This leads to:
- Risk of API response type inconsistencies
- Duplicate maintenance effort
- Potential runtime errors due to type mismatches

## Solution: OpenAPI-based Type Generation

### Strategy

1. **OpenAPI spec as Single Source of Truth** - The existing `docs/openapi.yaml` defines all API schemas
2. **Auto-generated TypeScript types** - Use `openapi-generator` to generate TypeScript types from the spec
3. **Phased Migration** - Keep existing manual types as reference/adapter while transitioning

### Implementation Plan

1. **Setup openapi-generator** in frontend as dev dependency
2. **Add npm script** `generate:types` to regenerate types from OpenAPI spec
3. **Create generated types directory** `frontend/src/types/generated/`
4. **Update frontend imports** to use generated types
5. **Document the workflow** for keeping types in sync

### Generated Types Location

```
frontend/src/types/generated/
├── api.d.ts          # Generated API types
└── index.d.ts         # Re-exports for convenient imports
```

### Workflow

When API changes:
1. Update `docs/openapi.yaml` with new/updated schemas
2. Run `npm run generate:types` in frontend
3. Review generated types and update consuming code if needed

### Limitations

- Generated types may need manual adjustment for complex scenarios
- Go backend types remain manually managed (acceptable for Go's compile-time guarantees)
- Some frontend-specific types (e.g., `Agent` extending `User`) may need custom handling

### References

- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
- [openapi-generator](https://openapi-generator.tech/)
- [ADR-0006](docs/adr/ADR-0006-type-sharing-strategy.md)