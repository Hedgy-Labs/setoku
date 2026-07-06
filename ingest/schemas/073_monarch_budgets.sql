-- SPDX-License-Identifier: Apache-2.0
-- Monarch Money monthly budgets: planned vs. actual per category per month (from
-- the Common_GetJointPlanningData / budgetData query). One row per (month,
-- category). Budgets are edited over time, so this is a ReplacingMergeTree keyed
-- by (month, category_id) with `ingested_at` as the version — newest wins.
--
-- `planned_amount` is the budget target (plannedCashFlowAmount). `actual_amount`
-- is what was actually spent/earned in that category that month. Sign follows the
-- category type: expense categories are negative actuals, income positive. Rows
-- with no plan AND no actual are dropped by the poller. Empty-string category
-- names mean the category was deleted after the budget was set.
--
-- Query current state with FINAL. Schema verified against budgetData (2026).
CREATE TABLE IF NOT EXISTS setoku.monarch_budgets
(
    month            Date                    COMMENT 'budget month (first of month)',
    category_id      String                  COMMENT 'Monarch category id',
    category         LowCardinality(String)  COMMENT 'category name at observation time',
    category_group   LowCardinality(String)  COMMENT 'parent category group name',
    group_type       LowCardinality(String)  COMMENT 'group type (income / expense / transfer)',
    planned_amount   Float64                 COMMENT 'budgeted/planned amount for the month, USD',
    actual_amount    Float64                 COMMENT 'actual amount in the category that month, USD (signed by type)',
    remaining_amount Float64                 COMMENT 'planned minus actual (Monarch-computed)',
    ingested_at      DateTime64(3)           COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(month)
ORDER BY (month, category_id)
COMMENT 'Monarch monthly budgets: planned vs actual per category. One row per (month, category); query with FINAL.';
