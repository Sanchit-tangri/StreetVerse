import React, { useEffect, useState } from 'react';

export interface SecureDocumentPreviewTarget {
  documentId: string;
  filename: string;
  mimeType: string;
  sha256Checksum?: string;
}

export interface SecureDocumentPreviewModalProps {
  target: SecureDocumentPreviewTarget | null;
  loader: (documentId: string) => Promise<{
    ok: boolean;
    error: string | null;
    blob?: Blob;
    mimeType?: string;
    filename?: string;
  }>;
  onClose: () => void;
}

export const SecureDocumentPreviewModal: React.FC<SecureDocumentPreviewModalProps> = ({
  target,
  loader,
  onClose
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [resolvedMime, setResolvedMime] = useState<string>('');
  const [resolvedName, setResolvedName] = useState<string>('');

  useEffect(() => {
    if (!target) {
      setObjectUrl(null);
      setError(null);
      return;
    }

    let cancelled = false;
    let activeUrl: string | null = null;
    setLoading(true);
    setError(null);
    setObjectUrl(null);
    setResolvedMime(target.mimeType);
    setResolvedName(target.filename);

    void loader(target.documentId).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.blob) {
        setError(res.error || 'Unable to load document securely.');
        return;
      }
      activeUrl = URL.createObjectURL(res.blob);
      setObjectUrl(activeUrl);
      if (res.mimeType) setResolvedMime(res.mimeType);
      if (res.filename) setResolvedName(res.filename);
    });

    return () => {
      cancelled = true;
      if (activeUrl) {
        URL.revokeObjectURL(activeUrl);
      }
    };
  }, [target, loader]);

  if (!target) return null;

  const isImage = resolvedMime.startsWith('image/');
  const isPdf = resolvedMime === 'application/pdf';

  return (
    <div className="fixed inset-0 z-[70] bg-inverse-surface/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface-container-lowest max-w-3xl w-full max-h-[90vh] rounded-2xl border border-surface-container shadow-2xl flex flex-col overflow-hidden">
        <div className="px-5 py-3.5 border-b border-surface-container flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h4 className="font-headline-sm text-sm font-bold text-on-surface truncate">
              {resolvedName || target.filename}
            </h4>
            <p className="text-[11px] font-mono text-outline truncate">
              {resolvedMime}
              {target.sha256Checksum ? ` • SHA-256: ${target.sha256Checksum.slice(0, 16)}...` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {objectUrl && (
              <a
                href={objectUrl}
                download={resolvedName || target.filename}
                className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-sm">download</span>
                <span>Download</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface"
              aria-label="Close document preview"
            >
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 bg-surface-container-low flex items-center justify-center min-h-[320px]">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-on-surface-variant">
              <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
              <span>Streaming document with authenticated Bearer authorization...</span>
            </div>
          ) : error ? (
            <div role="alert" className="p-4 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold max-w-md text-center">
              {error}
            </div>
          ) : objectUrl && isImage ? (
            <img
              src={objectUrl}
              alt={resolvedName || 'KYC Document Preview'}
              className="max-w-full max-h-[70vh] object-contain rounded-lg border border-surface-container shadow-xs"
            />
          ) : objectUrl && isPdf ? (
            <iframe
              title={resolvedName || 'KYC PDF Preview'}
              src={objectUrl}
              className="w-full h-[70vh] rounded-lg border border-surface-container bg-white"
            />
          ) : objectUrl ? (
            <div className="text-center text-xs text-on-surface-variant flex flex-col items-center gap-3">
              <span className="material-symbols-outlined text-4xl text-primary">description</span>
              <p>Inline preview is not supported for {resolvedMime}. Use Download above to inspect safely.</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
