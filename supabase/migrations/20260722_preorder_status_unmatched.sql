ALTER TABLE preorder_requests DROP CONSTRAINT IF EXISTS preorder_requests_status_check;
ALTER TABLE preorder_requests ADD CONSTRAINT preorder_requests_status_check
  CHECK (status = ANY (ARRAY['pending','allocated','overflow','locked','needs_size','unmatched']));
