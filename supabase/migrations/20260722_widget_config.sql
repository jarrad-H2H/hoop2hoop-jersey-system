-- Per-club widget configuration: controls field visibility, age group mode, and
-- other per-club overrides for the customer-facing JerseyWidget. Null = use defaults.
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS widget_config JSONB;
