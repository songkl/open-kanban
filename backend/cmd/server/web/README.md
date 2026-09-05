# web/

This directory is where the frontend SPA bundle gets copied at
build time:

- **Local dev**: `cd frontend && npm run build` (or `scripts/build-frontend.sh`).
- **Release**: `scripts/release.sh` (or the GitHub `release` workflow)
  copies `frontend/dist/` here before `go build` embeds it.
- **Fresh clone / CI**: this directory is empty by design. The CI
  build runs the frontend build first (see the `frontend-build`
  job in `.github/workflows/ci.yml`) and then the backend
  build embeds the populated directory.

The reason we keep the directory tracked (with this README as
the embeddable file) is that `//go:embed web` in
`cmd/server/main.go` requires at least one non-hidden file at
compile time. Go's embed ignores files whose names start with
`.` or `_` (so `.gitkeep` doesn't count), and it refuses to
embed an otherwise-empty directory. Without this file,
`go build` / `go test` fails with:

  pattern web: cannot embed directory web: contains no embeddable files

Anything in here at build time (assets/, index.html, …) is
generated and gitignored; only this README is tracked.
