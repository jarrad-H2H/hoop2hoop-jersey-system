-- 2026-07-20: Pre-allocated mode for pre-order system
-- Supports clubs that pre-assign jersey numbers; widget only collects size + confirms jersey name.

-- 1. Add allocation_type to clubs
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS allocation_type TEXT NOT NULL DEFAULT 'fcfs';
ALTER TABLE clubs DROP CONSTRAINT IF EXISTS clubs_allocation_type_check;
ALTER TABLE clubs ADD CONSTRAINT clubs_allocation_type_check
  CHECK (allocation_type IN ('fcfs', 'pre_allocated'));

-- 2. Add jersey_name to preorder_requests (confirmed last-name for back-of-jersey printing)
ALTER TABLE preorder_requests ADD COLUMN IF NOT EXISTS jersey_name TEXT;

-- 3. Parent contact info — stored as admin backstop, never exposed in UI
ALTER TABLE preorder_requests ADD COLUMN IF NOT EXISTS parent_1_name   TEXT;
ALTER TABLE preorder_requests ADD COLUMN IF NOT EXISTS parent_1_email  TEXT;
ALTER TABLE preorder_requests ADD COLUMN IF NOT EXISTS parent_1_mobile TEXT;
ALTER TABLE preorder_requests ADD COLUMN IF NOT EXISTS parent_2_name   TEXT;
ALTER TABLE preorder_requests ADD COLUMN IF NOT EXISTS parent_2_email  TEXT;
ALTER TABLE preorder_requests ADD COLUMN IF NOT EXISTS parent_2_mobile TEXT;

-- 4. Allow size to be NULL — pre-allocated rows don't have size until player confirms
ALTER TABLE preorder_requests ALTER COLUMN size DROP NOT NULL;

-- 5. Add 'needs_size' status for pre-allocated rows awaiting player size confirmation
ALTER TABLE preorder_requests DROP CONSTRAINT IF EXISTS preorder_requests_status_check;
ALTER TABLE preorder_requests ADD CONSTRAINT preorder_requests_status_check
  CHECK (status IN ('pending', 'allocated', 'overflow', 'locked', 'needs_size'));
