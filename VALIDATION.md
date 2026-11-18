# Verification record

## Verified on GitHub Actions

[Import reliability tests — successful run](https://github.com/TechiLoki/stockroom/actions/runs/44304700108)

Tested source commit: `8f2fe98e239041ddbeef2347f1da7ba4d65d061a`.

The run completed:

- A fresh dependency install from the committed lockfile.
- Strict TypeScript build and all 31 Node test cases, executed as direct test modules.
- Runtime Docker image build and API/database startup.
- PostgreSQL assertions for explicit partial opt-in, supplier-reference deduplication/conflicts, claim exclusivity, stale-worker fencing, additive stock, older-snapshot protection, strict transaction rollback, exhausted leases, retry recovery and role permissions.
- A real HTTP import smoke test: CSV and XLSX uploads, preview, invalid-row blocking, valid-only confirmation, import completion, duplicate reference replay, two additive shipments, conflicting settings, stale replacement snapshots and safe error CSV downloads.

## Also checked locally

TypeScript 5.9.3 strict compilation, browser asset generation, 31 individually visible Node cases, 63 static DOM references, Compose configuration, CLI syntax and initialization-shell syntax passed. ZIP/XLSX fixtures were created independently using Python's standard ZIP writer and OOXML parts; the application has no Python runtime dependency.

## Not verified

- Browser visual/interaction testing.
- Opening the fixture in an actual Microsoft Excel application.
- Arbitrary workbook compatibility, a production deployment or large-file performance benchmarks.

The XLSX reader intentionally supports a bounded value-oriented subset. Formulas, external links, macros, legacy formats and numeric Excel date serials are documented and rejected/flagged rather than silently interpreted.

Local Docker access is restricted; the container/database checks above were verified on GitHub Actions instead.
