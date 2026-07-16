-- Add super admin flag to admin_users.
-- Only super admins can invite, delete, and reset passwords for other staff.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE admin_users SET is_super_admin = TRUE WHERE user_id = '93797108-6b34-46e1-8a3c-c8f52e390ac1';
