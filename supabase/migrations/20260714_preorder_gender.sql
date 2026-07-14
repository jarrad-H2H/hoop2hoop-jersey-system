-- Add gender field to preorder_requests (Male / Female only)
ALTER TABLE preorder_requests
  ADD COLUMN IF NOT EXISTS gender TEXT CHECK (gender IN ('Male', 'Female'));
