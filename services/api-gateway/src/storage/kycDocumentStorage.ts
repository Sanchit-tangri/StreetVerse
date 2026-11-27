import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// =========================================================================
// KYC Document Storage Abstraction
//
// Security contract:
//   - Never returns or logs raw filesystem paths.
//   - Never exposes storage_key structure beyond this module and DB metadata.
//   - Files stored under a private directory unreachable by Express static.
//   - Filenames are CSPRNG-derived; original filename is never used on disk.
//   - Magic bytes validated before writing (JPEG / PNG / PDF only).
//   - SHA-256 checksum computed by this module from actual file bytes.
//   - Strict path.resolve check prevents directory traversal.
//
// Limitation (MO-A scope):
//   At-rest encryption is NOT implemented in this stage. Files are stored
//   as plaintext bytes on the configured private filesystem directory.
//   Production deployments must mount an encrypted persistent volume or
//   implement a private S3-compatible/object-storage adapter with SSE.
// =========================================================================

export const KYC_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const KYC_ALLOWED_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'application/pdf'
]);

/** Magic byte signatures for supported document types. */
const MAGIC_SIGNATURES: Array<{ mime: string; bytes: number[]; offset: number }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], offset: 0 } // %PDF-
];

/** Allowed extensions per MIME type (used only for the opaque storage key). */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/pdf': '.pdf'
};

export class KycStorageValidationError extends Error {
  public readonly statusCode = 400;
  public readonly code: string;
  constructor(message: string, code = 'INVALID_DOCUMENT') {
    super(message);
    this.name = 'KycStorageValidationError';
    this.code = code;
    Object.setPrototypeOf(this, KycStorageValidationError.prototype);
  }
}

export class KycStorageNotFoundError extends Error {
  public readonly statusCode = 404;
  public readonly code = 'DOCUMENT_FILE_NOT_FOUND';
  constructor(message = 'Stored document could not be found.') {
    super(message);
    this.name = 'KycStorageNotFoundError';
    Object.setPrototypeOf(this, KycStorageNotFoundError.prototype);
  }
}

export class KycStorageUnavailableError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'STORAGE_UNAVAILABLE';
  constructor(message = 'Document storage service is temporarily unavailable.') {
    super(message);
    this.name = 'KycStorageUnavailableError';
    Object.setPrototypeOf(this, KycStorageUnavailableError.prototype);
  }
}

export interface KycStoreParams {
  /** Raw file bytes (must not exceed KYC_MAX_FILE_SIZE_BYTES). */
  buffer: Buffer;
  /** MIME type declared by the client; validated strictly against magic bytes. */
  mimeType: string;
  /** Original filename (used only for sanitisation + display metadata, never on disk). */
  originalFilename: string;
}

export interface KycStoreResult {
  /** Opaque storage key (CSPRNG-derived; never a raw filesystem path). */
  storageKey: string;
  /** SHA-256 hex digest computed from file bytes. */
  sha256: string;
  /** Validated MIME type (from magic bytes check). */
  mimeType: string;
  /** Bytes written. */
  fileSizeBytes: number;
  /** Sanitised original filename (for display metadata only). */
  originalFilenameSanitized: string;
}

export interface KycDocumentStorage {
  /**
   * Validates, stores privately, and returns an opaque storage key + SHA-256 checksum.
   * Throws KycStorageValidationError on oversized, empty, or invalid file content/type,
   * or KycStorageUnavailableError if underlying storage cannot persist bytes.
   */
  store(params: KycStoreParams): Promise<KycStoreResult>;

  /**
   * Retrieves file bytes by opaque storage key through authorised backend code.
   * Throws KycStorageValidationError, KycStorageNotFoundError, or KycStorageUnavailableError
   * without leaking filesystem paths.
   */
  retrieve(storageKey: string): Promise<Buffer>;

  /**
   * Permanently deletes a stored document (draft removal or orphaned upload cleanup).
   * Throws KycStorageValidationError, KycStorageNotFoundError, or KycStorageUnavailableError
   * without leaking filesystem paths.
   */
  delete(storageKey: string): Promise<void>;
}

/**
 * Returns the MIME type detected from magic bytes, or null if unrecognised.
 * Rejects SVG, HTML, executables, ZIP/archives, scripts, and unknown binary payloads.
 */
export function detectMimeFromMagicBytes(buffer: Buffer): string | null {
  for (const sig of MAGIC_SIGNATURES) {
    if (buffer.length < sig.offset + sig.bytes.length) continue;
    const matches = sig.bytes.every((b, i) => buffer[sig.offset + i] === b);
    if (matches) return sig.mime;
  }
  return null;
}

/**
 * Sanitises a filename for safe display metadata: strips path separators,
 * traversal sequences, control characters, and caps length.
 */
export function sanitizeOriginalFilename(original: string): string {
  if (typeof original !== 'string' || !original.trim()) return 'document';
  return (
    original
      .replace(/[/\\]/g, '_')
      .replace(/\.\./g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, 200)
      .trim() || 'document'
  );
}

/**
 * Computes SHA-256 hex digest from a Buffer.
 */
export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Private filesystem adapter for KYC document storage.
 *
 * Files are written to a dedicated private `storageDir` using CSPRNG-derived filenames
 * with owner-only permissions (`0o600` on POSIX). Only opaque `storageKey` values are
 * returned; raw filesystem paths are never exposed outside this adapter.
 *
 * Limitation: No at-rest encryption in MO-A. Production deployments require a persistent
 * encrypted volume (and backups) or SSE object storage implementing `KycDocumentStorage`.
 */
export class FilesystemKycDocumentStorage implements KycDocumentStorage {
  private readonly storageDir: string;

  constructor(storageDir: string) {
    if (typeof storageDir !== 'string' || !storageDir.trim()) {
      throw new Error('FilesystemKycDocumentStorage: storageDir must be a non-empty string.');
    }
    this.storageDir = path.resolve(storageDir);
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    } catch {
      throw new KycStorageUnavailableError('Unable to prepare private document storage directory.');
    }
  }

  /**
   * Resolves a storage key safely inside `storageDir`.
   * Rejects empty keys, path separators, traversal sequences, or drive prefixes.
   */
  private resolveStoragePath(storageKey: string): string {
    if (typeof storageKey !== 'string' || !storageKey.trim()) {
      throw new KycStorageValidationError('Invalid storage key: must be a non-empty string.', 'INVALID_STORAGE_KEY');
    }
    if (storageKey.includes('/') || storageKey.includes('\\') || storageKey.includes('..') || storageKey.includes('\0')) {
      throw new KycStorageValidationError('Invalid storage key: path components are not permitted.', 'INVALID_STORAGE_KEY');
    }
    const basename = path.basename(storageKey);
    if (basename !== storageKey) {
      throw new KycStorageValidationError('Invalid storage key: path components are not permitted.', 'INVALID_STORAGE_KEY');
    }
    const resolved = path.resolve(this.storageDir, basename);
    if (!resolved.startsWith(this.storageDir + path.sep)) {
      throw new KycStorageValidationError(
        'Invalid storage key: resolves outside permitted directory.',
        'INVALID_STORAGE_KEY'
      );
    }
    return resolved;
  }

  async store(params: KycStoreParams): Promise<KycStoreResult> {
    const { buffer, mimeType, originalFilename } = params;

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new KycStorageValidationError('Document upload error: file buffer is empty.', 'EMPTY_FILE');
    }
    if (buffer.length > KYC_MAX_FILE_SIZE_BYTES) {
      throw new KycStorageValidationError(
        `Document upload error: file size exceeds the 10 MB limit.`,
        'FILE_TOO_LARGE'
      );
    }

    const normalizedMime = (typeof mimeType === 'string' ? mimeType : '').trim().toLowerCase();
    if (!KYC_ALLOWED_MIME_TYPES.has(normalizedMime)) {
      throw new KycStorageValidationError(
        'Document upload error: unsupported file type. Only JPEG, PNG, and PDF files are accepted.',
        'INVALID_FILE_TYPE'
      );
    }

    const detectedMime = detectMimeFromMagicBytes(buffer);
    if (!detectedMime) {
      throw new KycStorageValidationError(
        'Document upload error: file signature not recognised. Only JPEG, PNG, and PDF files are accepted.',
        'INVALID_FILE_TYPE'
      );
    }
    if (detectedMime !== normalizedMime) {
      throw new KycStorageValidationError(
        'Document upload error: file content does not match the declared file type.',
        'MIME_MISMATCH'
      );
    }

    const sha256 = computeSha256(buffer);
    const ext = MIME_TO_EXT[normalizedMime] ?? '';
    const storageKey = `${crypto.randomBytes(32).toString('hex')}${ext}`;

    this.ensureDir();
    const targetPath = this.resolveStoragePath(storageKey);
    try {
      await fs.promises.writeFile(targetPath, buffer, { mode: 0o600, flag: 'wx' });
    } catch {
      throw new KycStorageUnavailableError('Failed to persist document in private storage.');
    }

    return {
      storageKey,
      sha256,
      mimeType: normalizedMime,
      fileSizeBytes: buffer.length,
      originalFilenameSanitized: sanitizeOriginalFilename(originalFilename)
    };
  }

  async retrieve(storageKey: string): Promise<Buffer> {
    const targetPath = this.resolveStoragePath(storageKey);
    try {
      return await fs.promises.readFile(targetPath);
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined;
      if (code === 'ENOENT') {
        throw new KycStorageNotFoundError('Document file does not exist in storage.');
      }
      throw new KycStorageUnavailableError('Unable to retrieve document from private storage.');
    }
  }

  async delete(storageKey: string): Promise<void> {
    const targetPath = this.resolveStoragePath(storageKey);
    try {
      await fs.promises.unlink(targetPath);
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined;
      if (code === 'ENOENT') {
        throw new KycStorageNotFoundError('Document file does not exist in storage.');
      }
      throw new KycStorageUnavailableError('Unable to delete document from private storage.');
    }
  }
}

export function createKycDocumentStorage(storageDir: string): KycDocumentStorage {
  return new FilesystemKycDocumentStorage(storageDir);
}
