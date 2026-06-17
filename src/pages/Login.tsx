// FILE: src/pages/Login.tsx
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { Lock } from "lucide-react";

const Login: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Forgot password state
  const [forgotMode, setForgotMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      navigate("/admin");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetLoading(true);
    setResetError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setResetSent(true);
    } catch (err: any) {
      setResetError(err.message ?? "Failed to send reset email.");
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
        {/* Header */}
        <div className="bg-slate-800 p-8 text-center">
          <div className="mx-auto w-16 h-16 bg-indigo-500 rounded-full flex items-center justify-center mb-4 text-white">
            <Lock size={28} />
          </div>
          <h2 className="text-3xl font-bold text-white">Hoop2Hoop</h2>
          <p className="text-indigo-200 mt-2">
            {forgotMode ? "Reset Password" : "Admin System Access"}
          </p>
        </div>

        <div className="p-8">

          {/* Sign In form */}
          {!forgotMode && (
            <form onSubmit={handleLogin} className="space-y-6">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
                  {error}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                  placeholder="admin@hoop2hoop.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  required
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className={`w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md transition-all duration-200 flex justify-center items-center ${
                  loading ? "opacity-75 cursor-not-allowed" : ""
                }`}
              >
                {loading && (
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                )}
                {loading ? "Authenticating..." : "Sign In"}
              </button>
              <p className="text-center text-sm text-gray-500">
                <button
                  type="button"
                  onClick={() => { setForgotMode(true); setError(null); }}
                  className="text-indigo-600 hover:underline"
                >
                  Forgot password?
                </button>
              </p>
            </form>
          )}

          {/* Forgot password form */}
          {forgotMode && !resetSent && (
            <form onSubmit={handleForgotPassword} className="space-y-6">
              <p className="text-sm text-gray-600">
                Enter your email and we will send you a link to set a new password.
              </p>
              {resetError && (
                <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
                  {resetError}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                  placeholder="admin@hoop2hoop.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <button
                type="submit"
                disabled={resetLoading}
                className={`w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md transition-all flex justify-center items-center ${
                  resetLoading ? "opacity-75 cursor-not-allowed" : ""
                }`}
              >
                {resetLoading && (
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                )}
                {resetLoading ? "Sending..." : "Send Reset Link"}
              </button>
              <p className="text-center text-sm text-gray-500">
                <button
                  type="button"
                  onClick={() => { setForgotMode(false); setResetError(null); }}
                  className="text-indigo-600 hover:underline"
                >
                  Back to login
                </button>
              </p>
            </form>
          )}

          {/* Reset email sent confirmation */}
          {forgotMode && resetSent && (
            <div className="space-y-6 text-center">
              <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-4 rounded-lg text-sm">
                Reset link sent to <strong>{email}</strong>. Check your inbox and click the link to set a new password.
              </div>
              <button
                type="button"
                onClick={() => { setForgotMode(false); setResetSent(false); setResetError(null); }}
                className="text-indigo-600 hover:underline text-sm"
              >
                Back to login
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default Login;
