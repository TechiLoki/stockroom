# Stockroom: from supplier spreadsheets to auditable stock

A small business receives differently structured supplier files. Copying rows manually risks duplicate products, invalid prices, and adding the same shipment twice.

Stockroom separates parsing, mapping, validation, confirmation, and application. A preview identifies source-row errors before stock is touched. Invalid rows need correction or explicit valid-only import. Each supplier reference identifies one immutable business event, so a repeated confirmation cannot increment stock again.

TypeScript owns the parser, rules and UI. PostgreSQL serializes supplier mutations, fences worker leases and applies batches transactionally. The internal PostgREST API avoids exposing raw table writes. Completed imports retain source rows, outcomes and before/after values.

The implementation chooses exact minor-unit money, explicit stock policies and date-level freshness over fuzzy conversions. XLSX support is deliberately limited to safe value-based worksheets. The included fixtures use synthetic data.

Verification and remaining integration limits are recorded in VALIDATION.md. The full container/database workflow passed on GitHub Actions run 44304700108. Browser visual testing and actual Excel-application compatibility remain unverified.
