import { Timestamp } from 'firebase-admin/firestore';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import Stripe from 'stripe';
import { collections } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { transitionState, StateMachineError } from '../lib/state-machine.js';
import {
    Checkout,
    CheckoutState,
    Guests,
    GuestInfo,
    Quote,
    EXPIRABLE_STATES,
} from '../models/checkout.js';
import { getStaysClient } from './stays-client.js';
import { StaysPriceResponse } from './stays-types.js';

/**
 * Checkout Service
 * 
 * Orchestrates the checkout flow with:
 * - Locked quotes (immutable pricing)
 * - Lock-first reservation (anti-overbooking)
 * - Firestore transactions for idempotency
 * - Stripe integration (amount in centavos)
 */

const HOLD_TTL_MINUTES = parseInt(process.env.CHECKOUT_HOLD_TTL_MINUTES || '15', 10);
const QUOTE_TTL_MINUTES = parseInt(process.env.CHECKOUT_QUOTE_TTL_MINUTES || '30', 10);

// Stripe client
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-02-24.acacia',
});

export interface InitCheckoutParams {
    listingId: string;
    checkIn: string;
    checkOut: string;
    guests: Guests;
    couponCode?: string;
    metadata?: {
        userAgent?: string;
        ipAddress?: string;
        referrer?: string;
    };
}

export class CheckoutService {
    /**
     * Initialize a new checkout with locked quote
     */
    async initializeCheckout(params: InitCheckoutParams): Promise<Checkout> {
        const log = logger.child({ listingId: params.listingId });

        log.info('Initializing checkout', {
            checkIn: params.checkIn,
            checkOut: params.checkOut,
            guests: params.guests,
        });

        const staysClient = getStaysClient();

        // Get listing details for name
        const listing = await staysClient.getListingDetail(params.listingId);

        // Calculate price via Stays API
        const priceResponse = await staysClient.calculatePrice({
            listingId: params.listingId,
            checkIn: params.checkIn,
            checkOut: params.checkOut,
            guests: params.guests.adults + params.guests.children,
            couponCode: params.couponCode,
        });

        // Create locked quote
        const quote = this.createLockedQuote(params, priceResponse);

        const now = Timestamp.now();
        const checkoutId = uuidv4();

        const checkout: Checkout = {
            checkoutId,
            createdAt: now,
            updatedAt: now,
            state: CheckoutState.INITIATED,
            stateHistory: [{
                from: CheckoutState.INITIATED, // Initial state
                to: CheckoutState.INITIATED,
                timestamp: now,
                reason: 'Checkout initialized',
                actor: 'user',
            }],
            listingId: params.listingId,
            listingName: listing.publicName,
            checkIn: params.checkIn,
            checkOut: params.checkOut,
            guests: params.guests,
            quote,
            idempotencyKey: uuidv4(),
            retryCount: 0,
            metadata: params.metadata || {},
        };

        await collections.checkouts.doc(checkoutId).set(checkout);

        log.info('Checkout initialized', { checkoutId, total: quote.total });

        return checkout;
    }

    /**
     * Get checkout by ID
     */
    async getCheckout(checkoutId: string): Promise<Checkout | null> {
        const doc = await collections.checkouts.doc(checkoutId).get();
        return doc.exists ? (doc.data() as Checkout) : null;
    }

    /**
     * Update guest information
     */
    async updateGuestInfo(checkoutId: string, guest: GuestInfo): Promise<Checkout> {
        const docRef = collections.checkouts.doc(checkoutId);

        await docRef.update({
            guest,
            updatedAt: Timestamp.now(),
        });

        const doc = await docRef.get();
        return doc.data() as Checkout;
    }

    /**
     * Create hold (reserved) in Stays
     * 
     * This is TRANSACTIONAL and IDEMPOTENT:
     * - Uses Firestore transaction to prevent race conditions
     * - If already in HOLD_CREATED, returns existing checkout
     * - Creates "reserved" booking in Stays
     */
    async createHold(checkoutId: string): Promise<Checkout> {
        const log = logger.child({ checkoutId });

        const docRef = collections.checkouts.doc(checkoutId);

        return collections.checkouts.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);

            if (!doc.exists) {
                throw new Error(`Checkout ${checkoutId} not found`);
            }

            const checkout = doc.data() as Checkout;

            // Idempotency: if already has hold, return as-is
            if (checkout.state === CheckoutState.HOLD_CREATED ||
                checkout.staysReservationId) {
                log.info('Hold already exists (idempotent)', {
                    staysReservationId: checkout.staysReservationId,
                });
                return checkout;
            }

            // Validate state
            if (checkout.state !== CheckoutState.INITIATED) {
                throw new StateMachineError(
                    `Cannot create hold from state ${checkout.state}`,
                    checkoutId,
                    checkout.state,
                    CheckoutState.HOLD_CREATED,
                );
            }

            // Validate guest info
            if (!checkout.guest?.email) {
                throw new Error('Guest information required before creating hold');
            }

            // Create reserved booking in Stays
            const staysClient = getStaysClient();

            const reservation = await staysClient.createReservation({
                listingId: checkout.listingId,
                checkIn: checkout.checkIn,
                checkOut: checkout.checkOut,
                guests: checkout.guests.adults + checkout.guests.children,
                type: 'reserved',
                guest: {
                    firstName: checkout.guest.firstName,
                    lastName: checkout.guest.lastName,
                    email: checkout.guest.email,
                    phone: checkout.guest.phone,
                    document: checkout.guest.document,
                },
                source: 'vivare-web',
                totalPrice: checkout.quote.total,
                currency: checkout.quote.currency,
            });

            log.info('Stays reservation created (reserved)', {
                staysReservationId: reservation._id,
                staysBookingCode: reservation.code,
            });

            const now = Timestamp.now();
            const holdExpiresAt = Timestamp.fromMillis(
                Date.now() + HOLD_TTL_MINUTES * 60 * 1000
            );

            // Update checkout
            const updates: Partial<Checkout> = {
                state: CheckoutState.HOLD_CREATED,
                staysReservationId: reservation._id,
                holdExpiresAt,
                updatedAt: now,
                stateHistory: [
                    ...checkout.stateHistory,
                    {
                        from: checkout.state,
                        to: CheckoutState.HOLD_CREATED,
                        timestamp: now,
                        reason: 'Hold created in Stays',
                        actor: 'system',
                    },
                ],
            };

            transaction.update(docRef, updates);

            return { ...checkout, ...updates } as Checkout;
        });
    }

    /**
     * Create Stripe PaymentIntent
     * 
     * IMPORTANT:
     * - Amount is in centavos (BRL) - multiply by 100
     * - client_secret is returned but NOT persisted
     * - paymentIntentId IS persisted for webhook correlation
     */
    async createPaymentIntent(checkoutId: string): Promise<{
        clientSecret: string;
        state: CheckoutState;
    }> {
        const log = logger.child({ checkoutId });

        const checkout = await this.getCheckout(checkoutId);

        if (!checkout) {
            throw new Error(`Checkout ${checkoutId} not found`);
        }

        // Idempotency: if already has PaymentIntent, get existing
        if (checkout.stripePaymentIntentId) {
            log.info('PaymentIntent already exists, retrieving');
            const existingIntent = await stripe.paymentIntents.retrieve(
                checkout.stripePaymentIntentId
            );
            return {
                clientSecret: existingIntent.client_secret!,
                state: checkout.state,
            };
        }

        // Validate state
        if (checkout.state !== CheckoutState.HOLD_CREATED) {
            throw new Error(`Cannot create PaymentIntent from state ${checkout.state}. Hold required first.`);
        }

        // Convert to centavos (BRL smallest unit)
        const amountInCentavos = Math.round(checkout.quote.total * 100);

        // Validate currency
        if (checkout.quote.currency.toUpperCase() !== 'BRL') {
            throw new Error(`Unsupported currency: ${checkout.quote.currency}. Only BRL is supported.`);
        }

        // Create PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCentavos,
            currency: 'brl',
            metadata: {
                checkoutId,
                listingId: checkout.listingId,
                staysReservationId: checkout.staysReservationId!,
                checkIn: checkout.checkIn,
                checkOut: checkout.checkOut,
            },
            automatic_payment_methods: {
                enabled: true,
            },
            description: `Reserva ${checkout.listingName} - ${checkout.checkIn} a ${checkout.checkOut}`,
            receipt_email: checkout.guest?.email,
        });

        log.info('Stripe PaymentIntent created', {
            stripePaymentIntentId: paymentIntent.id,
            amount: amountInCentavos,
        });

        // Transition state and store PaymentIntent ID (NOT client_secret)
        await transitionState(checkoutId, CheckoutState.PAYMENT_CREATED, {
            actor: 'system',
            reason: 'PaymentIntent created',
            updates: {
                stripePaymentIntentId: paymentIntent.id,
                // NOTE: client_secret is NOT stored (security)
            },
        });

        return {
            clientSecret: paymentIntent.client_secret!,
            state: CheckoutState.PAYMENT_CREATED,
        };
    }

    /**
     * Handle payment succeeded (called by webhook)
     * 
     * - Transition to PAID
     * - Update Stays reservation to "booked"
     * - Register payment in Stays
     * - Transition to BOOKED
     */
    async handlePaymentSucceeded(checkoutId: string, paymentIntentId: string): Promise<Checkout> {
        const log = logger.child({ checkoutId, stripePaymentIntentId: paymentIntentId });

        // Transition to PAID
        let checkout = await transitionState(checkoutId, CheckoutState.PAID, {
            actor: 'webhook',
            reason: 'Payment succeeded',
        });

        // If already BOOKED, return (idempotent)
        if (checkout.state === CheckoutState.BOOKED) {
            log.info('Already BOOKED (idempotent skip)');
            return checkout;
        }

        const staysClient = getStaysClient();

        // Update Stays reservation to "booked"
        await staysClient.updateReservation(checkout.staysReservationId!, {
            type: 'booked',
        });

        log.info('Stays reservation updated to booked');

        // Register payment in Stays ledger
        await staysClient.registerPayment(checkout.staysReservationId!, {
            amount: checkout.quote.total,
            currency: checkout.quote.currency,
            method: 'credit_card',
            reference: paymentIntentId,
            notes: `Stripe PaymentIntent ${paymentIntentId}`,
        });

        log.info('Payment registered in Stays');

        // Get booking code from Stays
        const reservation = await staysClient.getReservation(checkout.staysReservationId!);

        // Transition to BOOKED
        checkout = await transitionState(checkoutId, CheckoutState.BOOKED, {
            actor: 'system',
            reason: 'Stays reservation confirmed',
            updates: {
                staysBookingCode: reservation.code,
            },
        });

        log.info('Checkout completed', { staysBookingCode: reservation.code });

        // TODO: Send confirmation email

        return checkout;
    }

    /**
     * Handle payment failed (called by webhook)
     */
    async handlePaymentFailed(checkoutId: string, reason: string): Promise<Checkout> {
        const log = logger.child({ checkoutId });

        log.warn('Payment failed', { reason });

        // We don't transition to FAILED immediately - user may retry
        // Just log and let the hold expire naturally if not retried

        const checkout = await this.getCheckout(checkoutId);

        if (!checkout) {
            throw new Error(`Checkout ${checkoutId} not found`);
        }

        // TODO: Send recovery email

        return checkout;
    }

    /**
     * Wait for checkout confirmation (polling for finalize endpoint)
     */
    async waitForConfirmation(checkoutId: string, maxWaitMs: number): Promise<Checkout> {
        const startTime = Date.now();
        const pollInterval = 1000; // 1 second

        while (Date.now() - startTime < maxWaitMs) {
            const checkout = await this.getCheckout(checkoutId);

            if (!checkout) {
                throw new Error(`Checkout ${checkoutId} not found`);
            }

            if (checkout.state === CheckoutState.BOOKED ||
                checkout.state === CheckoutState.FAILED ||
                checkout.state === CheckoutState.EXPIRED) {
                return checkout;
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // Return current state after timeout
        const checkout = await this.getCheckout(checkoutId);
        return checkout!;
    }

    /**
     * Cancel checkout (user-initiated)
     */
    async cancelCheckout(checkoutId: string, reason?: string): Promise<Checkout> {
        const log = logger.child({ checkoutId });

        const checkout = await this.getCheckout(checkoutId);

        if (!checkout) {
            throw new Error(`Checkout ${checkoutId} not found`);
        }

        // If has Stays reservation, cancel it
        if (checkout.staysReservationId) {
            const staysClient = getStaysClient();
            await staysClient.cancelReservation(checkout.staysReservationId);
            log.info('Stays reservation canceled');
        }

        // Transition to CANCELED
        return transitionState(checkoutId, CheckoutState.CANCELED, {
            actor: 'user',
            reason: reason || 'User canceled',
        });
    }

    /**
     * Expire stale holds (background job)
     */
    async expireHolds(): Promise<{ expiredCount: number; errorCount: number }> {
        const now = Timestamp.now();
        let expiredCount = 0;
        let errorCount = 0;

        // Query checkouts in expirable states with expired holdExpiresAt
        for (const state of EXPIRABLE_STATES) {
            const snapshot = await collections.checkouts
                .where('state', '==', state)
                .where('holdExpiresAt', '<', now)
                .limit(100) // Process in batches
                .get();

            for (const doc of snapshot.docs) {
                const checkout = doc.data() as Checkout;
                const log = logger.child({ checkoutId: checkout.checkoutId });

                try {
                    // Cancel Stays reservation
                    if (checkout.staysReservationId) {
                        const staysClient = getStaysClient();
                        await staysClient.cancelReservation(checkout.staysReservationId);
                        log.info('Expired hold - Stays reservation canceled');
                    }

                    // Transition to EXPIRED
                    await transitionState(checkout.checkoutId, CheckoutState.EXPIRED, {
                        actor: 'system',
                        reason: 'Hold TTL exceeded',
                    });

                    expiredCount++;
                } catch (error) {
                    log.error('Failed to expire hold', error);
                    errorCount++;
                }
            }
        }

        return { expiredCount, errorCount };
    }

    /**
     * Create locked quote from Stays price response
     */
    private createLockedQuote(params: InitCheckoutParams, priceResponse: StaysPriceResponse): Quote {
        // Create hash for quote validation
        const hashInput = [
            params.listingId,
            params.checkIn,
            params.checkOut,
            params.guests.adults,
            params.guests.children,
            params.guests.infants,
            params.couponCode || '',
        ].join('|');

        const hash = crypto
            .createHash('sha256')
            .update(hashInput)
            .digest('hex');

        const expiresAt = Timestamp.fromMillis(
            Date.now() + QUOTE_TTL_MINUTES * 60 * 1000
        );

        return {
            total: priceResponse.total,
            currency: priceResponse.currency,
            breakdown: {
                subtotal: priceResponse.subtotal,
                cleaningFee: priceResponse.cleaningFee,
                serviceFee: priceResponse.serviceFee,
                taxes: priceResponse.taxes,
            },
            hash,
            expiresAt,
        };
    }
}
