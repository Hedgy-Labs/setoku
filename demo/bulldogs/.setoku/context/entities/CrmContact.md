---
name: CrmContact
table: crm.contact
summary: Salesforce-style marketing contacts. NOT unique per person — duplicates and dirty emails by design. is_test__c flags internal records.
keywords: [crm, contact, contacts, salesforce, fan, customer, marketing list, email, duplicate, dedupe, do not email, notes, cs notes, service notes, complaints, preferences, feedback]
---

## Semantics

The marketing contact database. **`email` is not unique** — the same person has multiple
rows (different `sfid`), and emails are dirty (case, spaces, `+tags`). To count fans, dedupe
by normalized email and exclude test rows — see [[unique_fans]] / [[identity_resolution]].

- `is_test__c = true` → internal/test record, exclude.
- `do_not_email = true` → suppressed from email sends (respect for audience sizing).
- `lead_source`, `mailing_city`, `mailing_state` are often NULL.
- `sfid` is the Salesforce id (`003…`).
- **`cs_notes`** is free text a service rep typed about a fan's experience/preferences — only
  ~12% of rows have it, and it's deliberately **messy** (lowercase, typos, run-ons, abbreviations
  like "vm"=voicemail, "tix"=tickets). It's unstructured: treat it as qualitative signal (search
  with `ILIKE`/`~*` for themes like complaints, allergies, "do not call", seating prefs), not a
  clean categorical field. Useful for "what are fans complaining about" / preference mining; not a
  reliable basis for exact counts.

No foreign key to ticketing — link via normalized email.
