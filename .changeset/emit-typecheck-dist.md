---
'playwriter': patch
---

Keep local typechecks build-ready by running `pnpm typecheck` with TypeScript emit enabled.

This keeps `dist/` in sync when validating TypeScript changes locally, so the local `playwriter` command can run the compiled CLI instead of source files through `tsx`.
