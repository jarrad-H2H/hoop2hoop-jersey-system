// FILE: api/admin/users.ts
// Super-admin user management API. Requires a valid super-admin JWT.
// Actions: GET (list), POST invite|delete|reset-password
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// Invite and reset links go straight to our own /reset-password page (not Supabase's emailed
// /verify link, which depends on the project's Site URL and was never usable for an invite).
// The token is only spent when the person submits their new password there, so an email
// link-scanner opening the page can't use it up. The super admin sends the link themselves.
function setPasswordLink(req: VercelRequest, hashedToken: string, type: "invite" | "recovery"): string {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  return `https://${host}/reset-password?token_hash=${encodeURIComponent(hashedToken)}&type=${type}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Verify caller is a super admin
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { data: { user: caller } } = await supabase.auth.getUser(token);
  if (!caller) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { data: callerRow } = await supabase
    .from("admin_users")
    .select("is_super_admin")
    .eq("user_id", caller.id)
    .maybeSingle();

  if (!(callerRow as any)?.is_super_admin) {
    return res.status(403).json({ ok: false, error: "Super admin access required" });
  }

  // ── GET: list all admin users ───────────────────────────────────────────────
  if (req.method === "GET") {
    const { data: { users }, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const { data: adminRows } = await supabase.from("admin_users").select("user_id, is_super_admin");
    const adminMap = new Map((adminRows ?? []).map((a: any) => [a.user_id, a.is_super_admin as boolean]));

    const result = (users ?? [])
      .filter(u => adminMap.has(u.id))
      .map(u => ({
        id: u.id,
        email: u.email ?? "",
        last_sign_in_at: u.last_sign_in_at ?? null,
        created_at: u.created_at ?? null,
        is_super_admin: adminMap.get(u.id) ?? false,
      }));

    return res.status(200).json({ ok: true, users: result });
  }

  // ── POST: actions ───────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = req.body ?? {};
    const action = String(body.action ?? "");

    // Invite a new staff member: creates their account and returns a set-password link
    if (action === "invite") {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!email) return res.status(400).json({ ok: false, error: "Email required" });
      const superAdmin = body.superAdmin === true;

      const { data, error } = await supabase.auth.admin.generateLink({ type: "invite", email });
      if (error) {
        const already = /already (been )?registered|already exists/i.test(error.message);
        return res.status(400).json({
          ok: false,
          error: already
            ? `${email} already has an account. Use Reset Password next to their name to make them a new link.`
            : error.message,
        });
      }

      const { error: adminErr } = await supabase
        .from("admin_users")
        .upsert({ user_id: data.user.id, is_super_admin: superAdmin }, { onConflict: "user_id" });
      if (adminErr) return res.status(500).json({ ok: false, error: adminErr.message });

      return res.status(200).json({
        ok: true,
        userId: data.user.id,
        link: setPasswordLink(req, data.properties.hashed_token, "invite"),
      });
    }

    // Generate a set-new-password link for a staff member
    if (action === "reset-password") {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!email) return res.status(400).json({ ok: false, error: "Email required" });

      const { data, error } = await supabase.auth.admin.generateLink({
        type: "recovery",
        email,
      });
      if (error) return res.status(400).json({ ok: false, error: error.message });

      return res.status(200).json({ ok: true, link: setPasswordLink(req, data.properties.hashed_token, "recovery") });
    }

    // Delete a staff member account
    if (action === "delete") {
      const userId = String(body.userId ?? "").trim();
      if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
      if (userId === caller.id) {
        return res.status(400).json({ ok: false, error: "You cannot delete your own account" });
      }

      const { data: targetRow } = await supabase
        .from("admin_users")
        .select("is_super_admin")
        .eq("user_id", userId)
        .maybeSingle();
      if ((targetRow as any)?.is_super_admin) {
        return res.status(400).json({ ok: false, error: "Cannot delete another super admin" });
      }

      await supabase.from("admin_users").delete().eq("user_id", userId);
      const { error } = await supabase.auth.admin.deleteUser(userId);
      if (error) return res.status(400).json({ ok: false, error: error.message });

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ ok: false, error: "Method Not Allowed" });
}
