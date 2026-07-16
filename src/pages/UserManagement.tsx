// FILE: src/pages/UserManagement.tsx
// Super-admin only: invite staff, reset passwords, delete accounts.
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { UserCog, UserPlus, Trash2, KeyRound, ShieldCheck } from "lucide-react";

interface AdminUser {
  id: string;
  email: string;
  last_sign_in_at: string | null;
  created_at: string | null;
  is_super_admin: boolean;
}

async function apiCall(method: "GET" | "POST", body?: object): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token ?? "";
  const res = await fetch("/api/admin/users", {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

const UserManagement: React.FC = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string>("");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [actionMsg, setActionMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null); // userId being actioned

  const load = useCallback(async () => {
    setLoading(true);
    setActionMsg(null);
    const { data: { session } } = await supabase.auth.getSession();
    setCurrentUserId(session?.user?.id ?? "");

    const result = await apiCall("GET");
    if (result.ok) {
      setUsers(result.users ?? []);
      setIsSuperAdmin(true);
    } else {
      setIsSuperAdmin(false);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setInviteLoading(true);
    setInviteMsg(null);
    const result = await apiCall("POST", { action: "invite", email });
    if (result.ok) {
      setInviteMsg({ type: "ok", text: `Invite sent to ${email}. They'll receive an email to set their password.` });
      setInviteEmail("");
      await load();
    } else {
      setInviteMsg({ type: "err", text: result.error ?? "Invite failed" });
    }
    setInviteLoading(false);
  };

  const handleResetPassword = async (user: AdminUser) => {
    setActionLoading(user.id);
    setActionMsg(null);
    setResetLink(null);
    const result = await apiCall("POST", { action: "reset-password", email: user.email });
    if (result.ok && result.link) {
      setResetLink(result.link);
      setActionMsg({ type: "ok", text: `Password reset link generated for ${user.email}. Copy it and send it to them directly.` });
    } else {
      setActionMsg({ type: "err", text: result.error ?? "Failed to generate reset link" });
    }
    setActionLoading(null);
  };

  const handleDelete = async (user: AdminUser) => {
    if (!window.confirm(`Delete ${user.email}? They will immediately lose access.`)) return;
    setActionLoading(user.id);
    setActionMsg(null);
    const result = await apiCall("POST", { action: "delete", userId: user.id });
    if (result.ok) {
      setActionMsg({ type: "ok", text: `${user.email} has been removed.` });
      await load();
    } else {
      setActionMsg({ type: "err", text: result.error ?? "Delete failed" });
    }
    setActionLoading(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 text-sm">Loading…</div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
        <ShieldCheck size={40} className="text-gray-300" />
        <p className="text-gray-500 font-medium">Super admin access required</p>
        <p className="text-gray-400 text-sm">Contact Jarrad to be given super admin permissions.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <UserCog size={28} className="text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">Invite staff, reset passwords, and remove access.</p>
        </div>
      </div>

      {/* Invite form */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Invite New Staff Member</h2>
        <form onSubmit={handleInvite} className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Email address</label>
            <input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="staff@example.com"
              required
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={inviteLoading}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            <UserPlus size={15} />
            {inviteLoading ? "Sending…" : "Send Invite"}
          </button>
        </form>
        {inviteMsg && (
          <p className={`mt-3 text-sm ${inviteMsg.type === "ok" ? "text-green-700" : "text-red-700"}`}>
            {inviteMsg.text}
          </p>
        )}
      </div>

      {/* Action feedback */}
      {actionMsg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${actionMsg.type === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
          {actionMsg.text}
        </div>
      )}

      {/* Reset link */}
      {resetLink && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm">
          <p className="font-semibold text-yellow-800 mb-1">Password reset link (expires in 1 hour):</p>
          <input
            readOnly
            value={resetLink}
            onClick={e => (e.target as HTMLInputElement).select()}
            className="w-full font-mono text-xs bg-white border rounded px-2 py-1.5 text-gray-700"
          />
          <p className="text-yellow-700 text-xs mt-1">Copy and send this to the staff member. It expires after one use.</p>
        </div>
      )}

      {/* User table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs font-semibold text-gray-600 uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Email</th>
              <th className="px-4 py-3 text-left">Role</th>
              <th className="px-4 py-3 text-left">Last Sign In</th>
              <th className="px-4 py-3 text-left">Added</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const isSelf = u.id === currentUserId;
              const busy = actionLoading === u.id;
              return (
                <tr key={u.id} className="border-t border-gray-100 odd:bg-white even:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {u.email}
                    {isSelf && <span className="ml-2 text-xs text-gray-400">(you)</span>}
                  </td>
                  <td className="px-4 py-3">
                    {u.is_super_admin
                      ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-brand-100 text-brand-700"><ShieldCheck size={11} /> Super Admin</span>
                      : <span className="text-xs text-gray-500">Staff</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {u.last_sign_in_at
                      ? new Date(u.last_sign_in_at).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
                      : "Never"}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {u.created_at
                      ? new Date(u.created_at).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "2-digit", month: "short", year: "numeric" })
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {!isSelf && (
                        <button
                          onClick={() => handleResetPassword(u)}
                          disabled={busy}
                          title="Generate password reset link"
                          className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                        >
                          <KeyRound size={13} />
                          Reset Password
                        </button>
                      )}
                      {!isSelf && !u.is_super_admin && (
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={busy}
                          title="Remove this user's access"
                          className="flex items-center gap-1 px-3 py-1.5 border border-red-200 rounded text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
                        >
                          <Trash2 size={13} />
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">No staff accounts yet.</div>
        )}
      </div>
    </div>
  );
};

export default UserManagement;
