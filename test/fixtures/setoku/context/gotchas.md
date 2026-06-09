# Gotchas

- Customers with deleted_at set are soft-deleted — exclude from all customer counts (src/models/customer.ts:12)
- Refunded orders must be excluded from revenue entirely, not netted (src/billing/recognize.ts:77)
- All money columns are integer cents — divide by 100 for dollars (src/models/order.ts:31)
