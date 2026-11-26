export interface PhoneNormalizationResult {
  valid: boolean;
  e164?: string;
  isIndian?: boolean;
  /**
   * Candidate representations used for non-destructive lookups against legacy records
   * created before canonical E.164 storage was enforced.
   */
  legacyCandidates?: string[];
  error?: string;
}

const INDIAN_MOBILE_LOCAL_REGEX = /^[6-9]\d{9}$/;
const MAX_DB_PHONE_LENGTH = 15; // Matches current VARCHAR(15) schema until Stage 2 expansion

/**
 * Validates and normalizes phone numbers to canonical E.164 format.
 *
 * Indian numbers (explicit +91, 91, leading 0, or 10-digit local) must satisfy
 * ^[6-9]\d{9}$ and normalize to +91XXXXXXXXXX.
 * International numbers must carry an explicit '+' prefix and fit within the
 * current VARCHAR(15) column limit (up to 14 digits after '+').
 */
export function normalizePhoneNumber(rawInput: string): PhoneNormalizationResult {
  if (typeof rawInput !== 'string') {
    return { valid: false, error: 'Phone number must be a string.' };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { valid: false, error: 'Phone number is required.' };
  }

  // Strip common human formatting separators only
  const compact = trimmed.replace(/[\s\-()]/g, '');

  // Reject characters outside optional leading '+' and ASCII digits
  if (!/^\+?\d+$/.test(compact)) {
    return {
      valid: false,
      error: 'Invalid phone number format. Only digits, optional +, spaces, hyphens, and parentheses are allowed.'
    };
  }

  // Explicit '+91' Indian international format
  if (compact.startsWith('+91')) {
    const local = compact.slice(3);
    if (!INDIAN_MOBILE_LOCAL_REGEX.test(local)) {
      return {
        valid: false,
        error: 'Invalid Indian mobile number. Must be 10 digits starting with 6, 7, 8, or 9.'
      };
    }
    return buildIndianResult(local);
  }

  // Other explicit international '+' numbers (never treat bare digits without '+' as non-Indian)
  if (compact.startsWith('+')) {
    const digitsAfterPlus = compact.slice(1);
    if (!/^[1-9]\d{6,13}$/.test(digitsAfterPlus)) {
      if (compact.length > MAX_DB_PHONE_LENGTH) {
        return {
          valid: false,
          error: `International phone number exceeds current ${MAX_DB_PHONE_LENGTH}-character database limit.`
        };
      }
      return {
        valid: false,
        error: 'Invalid international phone number. Use E.164 format (+countrycode and 7-14 digits).'
      };
    }
    if (compact.length > MAX_DB_PHONE_LENGTH) {
      return {
        valid: false,
        error: `International phone number exceeds current ${MAX_DB_PHONE_LENGTH}-character database limit.`
      };
    }
    return {
      valid: true,
      e164: compact,
      isIndian: false,
      legacyCandidates: [compact]
    };
  }

  // Bare 10-digit Indian mobile
  if (compact.length === 10) {
    if (!INDIAN_MOBILE_LOCAL_REGEX.test(compact)) {
      return {
        valid: false,
        error: 'Invalid Indian mobile number. 10-digit numbers must start with 6, 7, 8, or 9.'
      };
    }
    return buildIndianResult(compact);
  }

  // Domestic leading '0' + 10-digit Indian mobile
  if (compact.length === 11 && compact.startsWith('0')) {
    const local = compact.slice(1);
    if (!INDIAN_MOBILE_LOCAL_REGEX.test(local)) {
      return {
        valid: false,
        error: 'Invalid Indian mobile number after leading 0.'
      };
    }
    return buildIndianResult(local);
  }

  // '91' + 10-digit Indian mobile without '+'
  if (compact.length === 12 && compact.startsWith('91')) {
    const local = compact.slice(2);
    if (!INDIAN_MOBILE_LOCAL_REGEX.test(local)) {
      return {
        valid: false,
        error: 'Invalid Indian mobile number after country code 91.'
      };
    }
    return buildIndianResult(local);
  }

  return {
    valid: false,
    error: 'Ambiguous or invalid phone number. Use a valid 10-digit Indian mobile number or include +<countryCode>.'
  };
}

function buildIndianResult(local10: string): PhoneNormalizationResult {
  const e164 = `+91${local10}`;
  return {
    valid: true,
    e164,
    isIndian: true,
    legacyCandidates: [e164, `91${local10}`, `0${local10}`, local10]
  };
}
