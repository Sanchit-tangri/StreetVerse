import React, { useState } from 'react';
import Link from 'next/link';
import { Shield, AlertCircle, Eye, EyeOff, RotateCw, ArrowRight } from 'lucide-react';
import {
  AdminAccountPublic,
  loginAdminAccount,
  resolveAdminApiUrl
} from '../../utils/adminSession';

export interface AdminAuthCardProps {
  sessionNotice?: string | null;
  onLoginSuccess: (payload: { token: string; admin: AdminAccountPublic }) => void;
}

export const AdminAuthCard: React.FC<AdminAuthCardProps> = ({
  sessionNotice = null,
  onLoginSuccess
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(sessionNotice || null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);

  const apiUrl = resolveAdminApiUrl();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setRetryAfterSeconds(null);
    setLoading(true);

    const res = await loginAdminAccount({
      apiUrl,
      email,
      password
    });

    setLoading(false);

    if (!res.ok || !res.data) {
      if (res.retryAfterSeconds) {
        setRetryAfterSeconds(res.retryAfterSeconds);
      }
      setError(res.error || 'Administrative authentication failed.');
      return;
    }

    onLoginSuccess({
      token: res.data.token,
      admin: res.data.admin
    });
  };

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6 font-body-md text-on-surface">
      <div className="w-full max-w-md bg-surface-container-lowest border border-surface-container rounded-2xl shadow-lg p-7 flex flex-col gap-5">
        <div className="text-center flex flex-col items-center gap-2">
          <div className="w-12 h-12 rounded-2xl bg-primary text-on-primary flex items-center justify-center shadow-sm">
            <Shield size={24} />
          </div>
          <h1 className="font-headline-sm text-2xl font-extrabold text-on-surface tracking-tight">
            Admin Operations Portal
          </h1>
          <p className="text-xs text-on-surface-variant">
            Isolated administrative authentication (`streetverse-admin`). Seller &amp; Buyer tokens are rejected.
          </p>
        </div>

        {(error || sessionNotice) && (
          <div
            role="alert"
            className="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold flex items-start gap-2"
          >
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <div>
              <p>{error || sessionNotice}</p>
              {retryAfterSeconds !== null && (
                <p className="mt-1 font-normal">
                  Login attempts temporarily throttled. Retry after ~{retryAfterSeconds}s.
                </p>
              )}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="admin-email-input" className="text-xs font-semibold text-on-surface block mb-1">
              Administrator Email
            </label>
            <input
              id="admin-email-input"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@streetverse.local"
              className="w-full bg-surface-container-low border border-surface-container rounded-xl px-3.5 py-2.5 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          <div>
            <label htmlFor="admin-password-input" className="text-xs font-semibold text-on-surface block mb-1">
              Password
            </label>
            <div className="relative">
              <input
                id="admin-password-input"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-surface-container-low border border-surface-container rounded-xl px-3.5 py-2.5 pr-10 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-xl bg-primary text-on-primary text-sm font-bold flex items-center justify-center gap-2 stitch-btn disabled:opacity-50"
          >
            {loading ? (
              <RotateCw size={16} className="spin" />
            ) : (
              <>
                <span>Authenticate Admin Session</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        <div className="pt-3 border-t border-surface-container flex items-center justify-between text-xs text-outline">
          <span>Protected by /api/v1/admin/me</span>
          <Link href="/" className="text-primary font-semibold hover:underline">
            Seller Portal →
          </Link>
        </div>
      </div>
    </div>
  );
};
