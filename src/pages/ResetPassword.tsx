// FILE: src/pages/ResetPassword.tsx
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { Lock } from "lucide-react";

type LinkType = "invite" | "recovery";

/**
 * Set-password page. Three ways in:
 *   1. Invite / reset link made on the User Management page (?token_hash=…&type=invite|recovery).
 *      The token is only spent when the person submits their new password, so an email
 *      link-scanner that opens the page can't use it up first.
 *   2. "Forgot password?" email sent by Supabase: lands with the session in the URL and fires
 *      PASSWORD_RECOVERY.
 *   3. Logged-in admin clicking "Change Password": already has a session.
 */
const ResetPassword: React.FC = () => {
  const navigate = useNavigate();
  const [linkToken] = useState<{ tokenHash: string; type: LinkType } | null>(() => {
    const q = new URLSearchParams(window.location.search);
    const tokenHash = q.get("token_hash");
    const type = q.get("type");
    return tokenHash && (type === "invite" || type === "recovery") ? { tokenHash, type } : null;
  });
  const [status, setStatus] = useState<"checking" | "ready" | "invalid" | "done">(linkToken ? "ready" : "checking");
  const [verified, setVerified] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (linkToken) return;

    // Supabase reports a failed emailed link (expired, already used) in the URL.
    const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
    if (params.get("error_description") || params.get("error_code")) {
      setStatus("invalid");
      return;
    }

    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!cancelled) setStatus((prev) => (prev === "checking" ? (session ? "ready" : "invalid") : prev));
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setStatus("ready");
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [linkToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      if (linkToken && !verified) {
        const { error: linkError } = await supabase.auth.verifyOtp({
          token_hash: linkToken.tokenHash,
          type: linkToken.type,
        });
        if (linkError) {
          setStatus("invalid");
          return;
        }
        setVerified(true);
      }
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setStatus("done");
      setTimeout(() => navigate("/admin"), 2000);
    } catch (err: any) {
      setError(err.message ?? "Failed to update password.");
    } finally {
      setLoading(false);
    }
  };

  const isInvite = linkToken?.type === "invite";

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="bg-slate-800 p-8 text-center">
          <div className="mx-auto w-16 h-16 bg-brand-500 rounded-full flex items-center justify-center mb-4 text-white">
            <Lock size={28} />
          </div>
          <h2 className="text-3xl font-bold text-white">Hoop2Hoop</h2>
          <p className="text-brand-200 mt-2">{isInvite ? "Set Up Your Login" : "Set New Password"}</p>
        </div>

        <div className="p-8">
          {status === "checking" ? (
            <p className="text-sm text-gray-500 text-center py-4">Checking your link&hellip;</p>
          ) : status === "invalid" ? (
            <div className="space-y-6 text-center">
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                This link has expired or has already been used. Ask the person who sent it to you for a new link.
              </div>
              <button type="button" onClick={() => navigate("/login")} className="text-brand-600 hover:underline text-sm">
                Back to login
              </button>
            </div>
          ) : status === "done" ? (
            <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm text-center">
              Password saved. Opening the admin panel&hellip;
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              {isInvite && (
                <p className="text-sm text-gray-600">Choose a password to finish setting up your admin login.</p>
              )}
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Confirm Password
                </label>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-colors"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className={`w-full py-3 px-4 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-lg shadow-md transition-all flex justify-center items-center ${
                  loading ? "opacity-75 cursor-not-allowed" : ""
                }`}
              >
                {loading && (
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                )}
                {loading ? "Saving..." : isInvite ? "Set Password" : "Update Password"}
              </button>

              <p className="text-center text-sm text-gray-500">
                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="text-brand-600 hover:underline"
                >
                  Back to login
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default ResetPassword;
