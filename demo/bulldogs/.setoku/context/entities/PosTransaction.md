---
name: PosTransaction
table: pos.txn
summary: A concession (food & beverage) sale at a stand during a game. Dollars. Line items in pos.txn_item. loyalty_id rarely ties to a fan. Completed games only.
keywords: [concession, concessions, pos, food, beverage, fnb, f&b, sale, stand, beer, hot dog, per cap, margin, loyalty, in-stadium, in-venue, kiosk, purchases, snack, drinks]
links: [fnb_per_cap, Event, identity_resolution]
---

## Semantics

One row per concession transaction; items in `pos.txn_item`. Money in **dollars**.

- `total` = subtotal + tax (dollars). Revenue ex-tax = `subtotal`.
- `event_no` → `ticketing.event` (no FK). `stand_id` → `pos.stand`.
- **`loyalty_id`** is populated on only ~15% of transactions; when present it's *sometimes* a `ticketing.account.acct_id` and sometimes an `APP######` id that matches nothing — so most F&B can't be attributed to a fan. See [[identity_resolution]].
- Only **completed** games have `pos` rows.
- Margin: `SUM((i.unit_price - i.unit_cost) * i.qty)` over `pos.txn_item i`.

See [[fnb_per_cap]].
