---
name: TicketingAccount
table: ticketing.account
summary: A ticketing-system account (the buyer behind seats). acct_type_cd classifies it; emails are dirty and some accounts are test/internal.
keywords: [account, buyer, ticketing account, sth, season ticket holder, corporate, group, comp, customer]
---

## Semantics

One row per ticketing account. `acct_id` is the ticketing ID space (referenced by
`seat_txn.acct_id`, and occasionally by `pos.txn.loyalty_id`).

- **acct_type_cd**: `STH` (season-ticket holder) · `SINGLE` · `GROUP` · `PREMIUM` · `CORP` · `COMP` (free).
- `acct_email` is **dirty** (mixed case, spaces, `+tags`) and sometimes NULL. Normalize before matching to CRM/merch — see [[identity_resolution]].
- **Test/internal accounts**: `acct_email ILIKE '%@stags.test'` (first name often `VOID`/`TEST`). Exclude from metrics.

No foreign key to CRM — link via normalized email.
