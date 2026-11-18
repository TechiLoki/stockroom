# Verification record

Executed locally:

- TypeScript 5.9.3 strict compilation using available Node type declarations.
- Browser asset generation and 63 static DOM references checked with no missing or duplicate element IDs.
- Three Node test modules were also run directly, so every individual test result was visible; all passed. They contain 31 declared cases covering CSV, ZIP/XLSX, XML input bounds, exact prices/dates, mapping, duplicate SKUs, error export escaping, inventory-aware preview, API authentication, partial-import opt-in, server-side revalidation, and worker RPC behavior.
- Parser tests read a ZIP/XLSX fixture created independently using Python's standard ZIP writer and OOXML parts.
- Compose configuration, Node smoke-script syntax, and database initialization shell syntax passed.

Not executed in this environment:

- Docker image build and fresh dependency installation using the committed lockfile.
- PostgreSQL schema/RPC integration assertions.
- Real multi-container HTTP import smoke test.
- Browser visual/interaction checks or actual Excel application compatibility checks.

The local sandbox denies Docker daemon access and local server sockets. Database and multi-container checks are supplied in tests/database.sql, scripts/smoke.mjs and the GitHub Actions workflow, but no successful remote CI run is claimed for Stockroom.

The XLSX reader intentionally supports a bounded value-oriented subset. Unsupported formulas, external links, macros, legacy files, and numeric Excel date serials are documented and rejected/flagged rather than silently interpreted.
