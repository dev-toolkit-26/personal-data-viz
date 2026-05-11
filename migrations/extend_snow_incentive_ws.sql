-- snow_incentive_ws: add per-month outlet count + incentive cost columns
-- Source: 26Y Snow Incentive_WS0506 2.xlsx (per-outlet rows aggregated by team)

ALTER TABLE snow_incentive_ws
  ADD COLUMN IF NOT EXISTS outlets3 int     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outlets4 int     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outlets5 int     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost3    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost4    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost5    numeric NOT NULL DEFAULT 0;
