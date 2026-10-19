-- migrations/003_add_decision_context_to_consumption_records.sql
-- Add decision_context column to record plan IDs, caps, and pre-decision balances at decision time
-- Architectural note: The default '{}' is strictly for backward compatibility with pre-existing records;
-- All new decisions (accepted and rejected) are required to explicitly persist full historical decision context.

ALTER TABLE consumption_records
ADD COLUMN decision_context JSONB NOT NULL DEFAULT '{}'::jsonb;
