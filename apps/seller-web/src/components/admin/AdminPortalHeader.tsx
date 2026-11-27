import React from 'react';
import Link from 'next/link';
import { AdminAccountPublic } from '../../utils/adminSession';

export interface AdminPortalHeaderProps {
  admin: AdminAccountPublic;
  subtitle?: string;
  onLogout: (notice?: string) => void;
}

export const AdminPortalHeader: React.FC<AdminPortalHeaderProps> = ({
  admin,
  subtitle,
  onLogout
}) => {
  return (
    <header className="fixed top-0 left-0 w-full z-50 bg-surface/90 backdrop-blur-xl border-b border-surface-container shadow-xs">
      <div className="h-20 w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-primary text-on-primary flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-xl">admin_panel_settings</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href="/admin" className="font-headline-sm text-base sm:text-lg font-bold text-on-surface hover:text-primary truncate">
                StreetVerse Admin Operations
              </Link>
              <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary text-[11px] font-bold">
                {admin.role}
              </span>
            </div>
            <p className="text-xs text-outline truncate">
              {admin.fullName} ({admin.email}) {subtitle ? `• ${subtitle}` : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/"
            className="hidden sm:flex items-center gap-1 px-3 py-1.5 rounded-xl bg-surface-container-low hover:bg-surface-container text-xs font-bold text-on-surface-variant"
          >
            <span className="material-symbols-outlined text-sm">storefront</span>
            <span>Seller Portal</span>
          </Link>
          <button
            type="button"
            onClick={() => onLogout()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-error/10 hover:bg-error/20 text-error text-xs font-bold"
          >
            <span className="material-symbols-outlined text-sm">logout</span>
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </header>
  );
};
