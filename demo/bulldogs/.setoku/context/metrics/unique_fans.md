---
name: unique_fans
summary: Count of unique fans — distinct NORMALIZED email across CRM, deduped and excluding test records. Naive COUNT(*) over crm.contact overcounts because of duplicates.
keywords: [unique fans, distinct fans, how many fans, contacts, customers, audience size, deduped, count people]
links: [CrmContact, identity_resolution, TicketingAccount, MerchAndMarketing]
---

## Definition

`crm.contact` has duplicate rows per person and dirty emails, so a raw `COUNT(*)` is wrong
(it overcounts). Count **distinct normalized email**, excluding test rows and NULL emails.

## Canonical SQL

```sql
SELECT
  count(*)                                        AS raw_contact_rows,      -- overcounts (dupes)
  count(DISTINCT lower(btrim(regexp_replace(email,'\+[^@]*@','@'))))
    FILTER (WHERE is_test__c = false AND email IS NOT NULL) AS unique_fans
FROM crm.contact;
```

For a fuller "known fan" universe you can union normalized emails from `crm.contact`,
`ticketing.account`, and `merch.online_order` — see [[identity_resolution]]. Expect the raw
row count to exceed unique fans by ~25–30% because of CRM duplication.
