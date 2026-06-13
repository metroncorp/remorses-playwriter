---
'playwriter': patch
---

Fix CLI-created extension sessions so `playwriter session new` can auto-create an initial tab even when the shared relay was started by MCP instead of the CLI.

Previously the CLI only passed `PLAYWRITER_AUTO_ENABLE=1` when it spawned a new relay. If an MCP process had already started the relay, CLI sessions reused that process without auto-enable and could fail with `No Playwright pages are available` after all enabled tabs closed.
