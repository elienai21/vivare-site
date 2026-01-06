import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { logger } from '../lib/logger.js';
import { checkWebhookIdempotency } from '../middleware/idempotency.js';
import { CheckoutService } from '../services/checkout-service.js';

const router = Router();
const checkoutService = new CheckoutService();

// Stripe client
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-12-15.clover',
});

/**
 * POST /webhooks/stripe
 * Handle Stripe webhook events
 * 
 * CRITICAL: This endpoint uses raw body for signature verification
 * The express.raw() middleware is applied in index.ts specifically for this route
 */
router.post('/stripe', async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

    let event: Stripe.Event;

    // Verify webhook signature
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        logger.error('Stripe webhook signature verification failed', err);
        res.status(400).json({ error: 'Invalid signature' });
        return;
    }

    const eventId = event.id;
    const log = logger.child({ stripeEventId: eventId, eventType: event.type });

    // Check idempotency (prevent double processing)
    const { processed, markProcessed } = await checkWebhookIdempotency(eventId);

    if (processed) {
        log.info('Webhook event already processed (idempotent skip)');
        res.json({ received: true, status: 'already_processed' });
        return;
    }

    log.info('Processing Stripe webhook event');

    try {
        switch (event.type) {
            case 'payment_intent.succeeded': {
                const paymentIntent = event.data.object as Stripe.PaymentIntent;
                const checkoutId = paymentIntent.metadata?.checkoutId;

                if (!checkoutId) {
                    log.warn('PaymentIntent missing checkoutId metadata');
                    break;
                }

                log.info('Processing payment_intent.succeeded', {
                    checkoutId,
                    stripePaymentIntentId: paymentIntent.id,
                    amount: paymentIntent.amount,
                    currency: paymentIntent.currency,
                });

                // Confirm booking (transition to PAID, then BOOKED)
                await checkoutService.handlePaymentSucceeded(checkoutId, paymentIntent.id);

                log.info('Booking confirmed successfully', { checkoutId });
                break;
            }

            case 'payment_intent.payment_failed': {
                const paymentIntent = event.data.object as Stripe.PaymentIntent;
                const checkoutId = paymentIntent.metadata?.checkoutId;

                if (!checkoutId) {
                    log.warn('PaymentIntent missing checkoutId metadata');
                    break;
                }

                log.warn('Payment failed', {
                    checkoutId,
                    stripePaymentIntentId: paymentIntent.id,
                    failureMessage: paymentIntent.last_payment_error?.message,
                });

                await checkoutService.handlePaymentFailed(
                    checkoutId,
                    paymentIntent.last_payment_error?.message || 'Payment failed',
                );
                break;
            }

            case 'charge.refunded': {
                const charge = event.data.object as Stripe.Charge;
                const paymentIntentId = charge.payment_intent as string;

                log.info('Charge refunded', {
                    stripePaymentIntentId: paymentIntentId,
                    amount: charge.amount_refunded,
                });

                // TODO: Handle refund (update checkout state, notify guest)
                break;
            }

            default:
                log.debug('Unhandled event type', { eventType: event.type });
        }

        // Mark event as processed
        await markProcessed();

        // IMPORTANT: Return 200 quickly (Stripe expects fast response)
        res.json({ received: true });

    } catch (error) {
        log.error('Error processing webhook event', error);

        // Return 500 so Stripe will retry
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/**
 * POST /webhooks/stays
 * Handle Stays.net webhook events (nice-to-have for MVP)
 */
router.post('/stays', async (req: Request, res: Response) => {
    // TODO: Implement Stays webhook handling
    // - Verify signature (if Stays supports it)
    // - Handle booking updates
    // - Invalidate caches

    logger.info('Received Stays webhook', { body: req.body });

    res.json({ received: true });
});

export default router;
