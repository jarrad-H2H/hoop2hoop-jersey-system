-- Add 'keep' to allocations.allocation_type check constraint.
-- Required for the MTO (made-to-order) reserve_jersey path which records
-- retention orders with allocation_type = 'keep'.
ALTER TABLE allocations
  DROP CONSTRAINT allocations_allocation_type_check;

ALTER TABLE allocations
  ADD CONSTRAINT allocations_allocation_type_check
  CHECK (allocation_type = ANY (ARRAY['new','swap','end','return','keep']));
