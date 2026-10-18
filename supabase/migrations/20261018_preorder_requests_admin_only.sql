-- preorder_requests let ANY logged-in user read and change every row (USING true). Every other
-- table is limited to people on admin_users via is_admin(); do the same here. The widget and
-- webhooks use the service role key (which bypasses these policies), so they are unaffected.
DROP POLICY IF EXISTS preorder_requests_admin_full ON public.preorder_requests;
CREATE POLICY admin_full_access ON public.preorder_requests
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());
