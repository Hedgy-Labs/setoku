---
name: CrmContact
table: crm.contact
summary: Salesforce-style marketing contacts. NOT unique per person — duplicates and dirty emails by design. is_test__c flags internal records.
keywords: [crm, contact, contacts, salesforce, fan, customer, marketing list, email, duplicate, dedupe, do not email]
---

## Semantics

The marketing contact database. **`email` is not unique** — the same person has multiple
rows (different `sfid`), and emails are dirty (case, spaces, `+tags`). To count fans, dedupe
by normalized email and exclude test rows — see [[unique_fans]] / [[identity_resolution]].

- `is_test__c = true` → internal/test record, exclude.
- `do_not_email = true` → suppressed from email sends (respect for audience sizing).
- `lead_source`, `mailing_city`, `mailing_state` are often NULL.
- `sfid` is the Salesforce id (`003…`).

No foreign key to ticketing — link via normalized email.
