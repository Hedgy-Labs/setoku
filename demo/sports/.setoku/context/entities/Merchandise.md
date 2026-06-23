---
name: Merchandise
table: public.merchandise
summary: The team-store catalog. One row per SKU with list vs purchase (cost) price, channel, vendor, and on-hand stock.
keywords: [merch, merchandise, store, retail, sku, jersey, hat, inventory, stock, vendor, margin, bundle]
---

## Semantics

A catalog (not a sales log) — one row per SKU currently carried in the team store.

- `list_price_cents` vs `purchase_price_cents` (unit cost) → unit margin.
- **channel**: `digital`, `brick_mortar`, or `both` (where the SKU is sold).
- `is_bundle` flags multi-item bundles.
- `quantity_available` is current on-hand stock (0 = out of stock).
- **category**: `jersey`, `hat`, `tee`, `memorabilia`, `kids`, `accessory`.

## Note

This table is the catalog only — there is no per-transaction merch sales table in this dataset.
