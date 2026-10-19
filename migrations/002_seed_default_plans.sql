-- migrations/002_seed_default_plans.sql

-- Seed system initial public default plans
-- Default account plan (plan_default_account)
-- Default user plan (plan_default_user)
INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
VALUES
  ('plan_default_account', 'Default Account Plan', 'ACCOUNT', 100000, 1000, NULL),
  ('plan_default_user', 'Default User Plan', 'USER', 10000, 500, NULL)
ON CONFLICT (id) DO NOTHING;
