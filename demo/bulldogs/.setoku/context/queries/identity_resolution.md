---
name: identity_resolution
summary: How to link a person across systems (ticketing, CRM, POS, merch) — there is no shared person ID, so match on a NORMALIZED email; CRM has duplicates that must be collapsed.
keywords: [identity, identity resolution, link fan, match person, dedupe, duplicate, join across systems, email, crm to ticketing, single view of fan, customer 360, loyalty]
---

## The problem

There is **no shared person ID** across systems. The same fan appears as a
`ticketing.account` (acct_email), one-or-more `crm.contact` rows (email), maybe a
`pos.txn.loyalty_id`, and a `merch.online_order.email`. Emails are dirty (mixed case,
trailing spaces, `+tags`) and CRM has duplicate rows for the same person. So any
"single view of the fan" requires **normalizing the email** and **deduping**.

## Canonical normalized-email expression

Use this everywhere you match or count people:

```sql
lower(btrim(regexp_replace(email, '\+[^@]*@', '@')))   -- lowercase, trim, strip +tags
```

## Link CRM ↔ ticketing (and dedupe CRM)

```sql
WITH norm_crm AS (
  SELECT DISTINCT lower(btrim(regexp_replace(email,'\+[^@]*@','@'))) AS nemail
  FROM crm.contact
  WHERE is_test__c = false AND email IS NOT NULL
),
norm_acct AS (
  SELECT acct_id, lower(btrim(regexp_replace(acct_email,'\+[^@]*@','@'))) AS nemail
  FROM ticketing.account
  WHERE acct_email IS NOT NULL AND acct_email NOT ILIKE '%@bonita.test'
)
SELECT count(*) AS ticketing_accounts_matched_in_crm
FROM norm_acct a JOIN norm_crm c USING (nemail);
```

## Tie a concession sale to a fan (limited!)

`pos.txn.loyalty_id` is populated on only ~15% of transactions, and when present it is
*sometimes* a `ticketing.account.acct_id` (numeric) and sometimes an app id (`APP######`)
that matches nothing. So **most F&B spend cannot be attributed to a fan** — state that
limitation rather than implying full coverage.

```sql
-- Filter to NUMERIC loyalty ids FIRST (most are NULL or 'APP######'), then match
-- on text so the integer cast never errors and the join stays small/fast. Total
-- txn count comes from a cheap subquery rather than a 800k-row LEFT JOIN.
SELECT (SELECT count(*) FROM pos.txn)             AS pos_txns_total,
       count(*)                                   AS pos_txns_linked_to_account
FROM pos.txn t
JOIN ticketing.account a ON a.acct_id::text = t.loyalty_id
WHERE t.loyalty_id ~ '^[0-9]+$';
```
