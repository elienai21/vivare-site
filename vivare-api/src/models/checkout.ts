import { Timestamp } from 'firebase-admin/firestore';

/**
 * Checkout State Machine
 * 
 * States flow:
 * INITIATED → HOLD_CREATED → PAYMENT_CREATED → PAID → BOOKED
 *                                              ↓
 *                                          CANCELED / EXPIRED / FAILED
 * 
 * Invariants:
 * - One checkoutId = max one `reserved` booking in Stays
 * - payment_intent.succeeded webhook never confirms twice (idempotent)
 * - Hold expires if state < PAID after TTL
 */

export enum CheckoutState {
    INITIATED = 'INITIATED',           // Wizard started, quote locked
    HOLD_CREATED = 'HOLD_CREATED',     // Stays reservation = "reserved"
    PAYMENT_CREATED = 'PAYMENT_CREATED', // Stripe PaymentIntent created
    PAID = 'PAID',                     // payment_intent.succeeded received
    BOOKED = 'BOOKED',                 // Stays reservation = "booked"
    CANCELED = 'CANCELED',             // User canceled
    EXPIRED = 'EXPIRED',               // TTL exceeded, hold released
    FAILED = 'FAILED',                 // Unrecoverable error
}

export interface GuestInfo {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    document?: string; // CPF (optional)
}

export interface QuoteBreakdown {
    subtotal: number;
    cleaningFee: number;
    serviceFee: number;
    taxes: number;
}

/**
 * Locked Quote - IMMUTABLE once created
 * NOTE: Do NOT store stripeClientSecret here (security risk)
 */
export interface Quote {
    total: number;
    currency: string;
    breakdown: QuoteBreakdown;
    /** SHA-256 hash of (listingId + checkIn + checkOut + guests + couponCode) */
    hash: string;
    /** Quote TTL for UX (e.g., 30 min) - different from hold TTL */
    expiresAt: Timestamp;
}

export interface Guests {
    adults: number;
    children: number;
    infants: number;
}

export interface StateTransition {
    from: CheckoutState;
    to: CheckoutState;
    timestamp: Timestamp;
    reason?: string;
    actor: 'user' | 'system' | 'webhook';
}

export interface CheckoutMetadata {
    userAgent?: string;
    ipAddress?: string;
    referrer?: string;
}

/**
 * Checkout Document (Firestore: checkouts/{checkoutId})
 * 
 * IMPORTANT:
 * - stripeClientSecret is NEVER persisted (returned only at creation time)
 * - stripePaymentIntentId IS persisted for webhook correlation
 */
export interface Checkout {
    // Identity
    checkoutId: string; // UUID
    createdAt: Timestamp;
    updatedAt: Timestamp;

    // State Machine
    state: CheckoutState;
    stateHistory: StateTransition[];

    // Booking Details
    listingId: string;
    listingName?: string; // For display purposes
    checkIn: string; // ISO date YYYY-MM-DD
    checkOut: string; // ISO date YYYY-MM-DD
    guests: Guests;

    // Locked Quote (immutable once created)
    quote: Quote;

    // Guest Information (collected in step 2)
    guest?: GuestInfo;

    // Stays Integration
    staysReservationId?: string; // After HOLD_CREATED
    staysBookingCode?: string; // After BOOKED (guest-facing code)

    // Stripe Integration
    /** PaymentIntent ID - persisted for webhook correlation */
    stripePaymentIntentId?: string;
    // NOTE: stripeClientSecret is NEVER stored (security)

    // Idempotency Keys
    /** For hold creation (prevents duplicate reservations) */
    idempotencyKey: string;

    // Expiration
    /** Hold TTL (10-15 min from HOLD_CREATED) - different from quote.expiresAt */
    holdExpiresAt?: Timestamp;

    // Retry tracking
    retryCount: number;

    // Metadata
    metadata: CheckoutMetadata;
}

/**
 * Valid state transitions map
 */
export const VALID_TRANSITIONS: Record<CheckoutState, CheckoutState[]> = {
    [CheckoutState.INITIATED]: [CheckoutState.HOLD_CREATED, CheckoutState.CANCELED, CheckoutState.FAILED],
    [CheckoutState.HOLD_CREATED]: [CheckoutState.PAYMENT_CREATED, CheckoutState.EXPIRED, CheckoutState.CANCELED, CheckoutState.FAILED],
    [CheckoutState.PAYMENT_CREATED]: [CheckoutState.PAID, CheckoutState.EXPIRED, CheckoutState.CANCELED, CheckoutState.FAILED],
    [CheckoutState.PAID]: [CheckoutState.BOOKED, CheckoutState.FAILED],
    [CheckoutState.BOOKED]: [CheckoutState.CANCELED], // Post-booking cancellation (if policy allows)
    [CheckoutState.CANCELED]: [],
    [CheckoutState.EXPIRED]: [],
    [CheckoutState.FAILED]: [],
};

/**
 * Terminal states (no further transitions possible)
 */
export const TERMINAL_STATES: CheckoutState[] = [
    CheckoutState.BOOKED,
    CheckoutState.CANCELED,
    CheckoutState.EXPIRED,
    CheckoutState.FAILED,
];

/**
 * States that can be expired by the background job
 */
export const EXPIRABLE_STATES: CheckoutState[] = [
    CheckoutState.HOLD_CREATED,
    CheckoutState.PAYMENT_CREATED,
];

/**
 * Validate if a state transition is allowed
 */
export function isValidTransition(from: CheckoutState, to: CheckoutState): boolean {
    return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Check if checkout can be expired
 */
export function canExpire(state: CheckoutState): boolean {
    return EXPIRABLE_STATES.includes(state);
}

/**
 * Check if checkout is in a terminal state
 */
export function isTerminal(state: CheckoutState): boolean {
    return TERMINAL_STATES.includes(state);
}
