export interface BookingReceipt {
  receiptId: string;
  tokenNumber: number;
  serviceName: string;
  status: string;
  appointmentTime?: string;
  qrVerificationCode: string;
}

export interface BookingFlowState {
  isSlotLocked: boolean;
  lockToken: string | null;
  slotCountdown: number;
  bookingConfirmedReceipt: BookingReceipt | null;
  bookingError: string | null;
}

const DEFAULT_BOOKING_UNAVAILABLE_MESSAGE =
  'Booking is temporarily unavailable. Please try again later.';

/**
 * Returns clean initial modal state with no fabricated lock token or receipt.
 */
export function createInitialBookingFlowState(): BookingFlowState {
  return {
    isSlotLocked: false,
    lockToken: null,
    slotCountdown: 300,
    bookingConfirmedReceipt: null,
    bookingError: null
  };
}

/**
 * Extracts a safe user-facing error message without inventing success data.
 */
export function extractBookingErrorMessage(
  status: number,
  data: any,
  fallback = DEFAULT_BOOKING_UNAVAILABLE_MESSAGE
): string {
  if (data && typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }
  if (data && typeof data.message === 'string' && data.message.trim() && status >= 400) {
    return data.message.trim();
  }
  if (status === 503) {
    return DEFAULT_BOOKING_UNAVAILABLE_MESSAGE;
  }
  return fallback;
}

/**
 * Maps a `/api/v1/bookings/lock-slot` response into UI state. Never fabricates `RESILIENT-*` tokens.
 */
export function resolveLockSlotOutcome(
  httpStatus: number,
  data: any
): Pick<BookingFlowState, 'isSlotLocked' | 'lockToken' | 'slotCountdown' | 'bookingError'> {
  if (
    httpStatus >= 200 &&
    httpStatus < 300 &&
    data &&
    data.success === true &&
    typeof data.lockToken === 'string' &&
    data.lockToken.trim().length > 0
  ) {
    return {
      isSlotLocked: true,
      lockToken: data.lockToken,
      slotCountdown: typeof data.expiresInSeconds === 'number' && data.expiresInSeconds > 0 ? data.expiresInSeconds : 300,
      bookingError: null
    };
  }

  return {
    isSlotLocked: false,
    lockToken: null,
    slotCountdown: 300,
    bookingError: extractBookingErrorMessage(httpStatus, data)
  };
}

/**
 * Maps a `/api/v1/bookings/confirm-payment` response into UI state.
 * Never fabricates receipts, token numbers, or QR codes on failure or missing payload.
 */
export function resolveConfirmBookingOutcome(
  httpStatus: number,
  data: any
): Pick<BookingFlowState, 'bookingConfirmedReceipt' | 'bookingError'> {
  if (
    httpStatus >= 200 &&
    httpStatus < 300 &&
    data &&
    data.success === true &&
    data.receipt &&
    typeof data.receipt.receiptId === 'string' &&
    data.receipt.receiptId.trim().length > 0
  ) {
    return {
      bookingConfirmedReceipt: data.receipt as BookingReceipt,
      bookingError: null
    };
  }

  return {
    bookingConfirmedReceipt: null,
    bookingError: extractBookingErrorMessage(httpStatus, data)
  };
}
