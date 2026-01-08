import { Router } from 'express';
import { asyncHandler, Errors } from '../middleware/error-handler.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { validate } from '../middleware/validate.js';
import {
    initializeCheckoutSchema,
    updateGuestSchema,
    finalizeCheckoutSchema
} from '../schemas/checkout-schema.js';
import { CheckoutService } from '../services/checkout-service.js';
import { CheckoutState } from '../models/checkout.js';

const router = Router();
const checkoutService = new CheckoutService();

/**
 * POST /checkout/initialize
 * Initialize a new checkout (creates locked quote)
 * 
 * Body: { listingId, checkIn, checkOut, guests, couponCode? }
 * Returns: { checkoutId, quote, ... }
 */
router.post('/initialize',
    idempotencyMiddleware({ required: false }),
    validate(initializeCheckoutSchema),
    asyncHandler(async (req, res) => {
        const { listingId, checkIn, checkOut, guests, couponCode, metadata } = req.body;

        const checkout = await checkoutService.initializeCheckout({
            listingId,
            checkIn,
            checkOut,
            guests,
            couponCode,
            metadata: {
                ...metadata,
                userAgent: req.headers['user-agent'],
                ipAddress: req.ip,
                referrer: req.headers.referer,
            },
        });

        res.status(201).json(checkout);
    }),
);

/**
 * GET /checkout/:checkoutId
 * Get checkout details
 */
router.get('/:checkoutId', asyncHandler(async (req, res) => {
    const { checkoutId } = req.params;

    const checkout = await checkoutService.getCheckout(checkoutId);

    if (!checkout) {
        throw Errors.notFound('Checkout');
    }

    res.json(checkout);
}));

/**
 * PATCH /checkout/:checkoutId/guest
 * Update guest information (step 2 of wizard)
 */
router.patch('/:checkoutId/guest',
    validate(updateGuestSchema),
    asyncHandler(async (req, res) => {
        const { checkoutId } = req.params;
        const { guest } = req.body;

        const checkout = await checkoutService.updateGuestInfo(checkoutId, guest);

        res.json(checkout);
    }));

/**
 * POST /checkout/:checkoutId/hold
 * Create hold (reserved) in Stays - TRANSACTIONAL, IDEMPOTENT
 * 
 * This is the lock-first step - creates a reserved booking in Stays
 * Must be called BEFORE creating PaymentIntent
 */
router.post('/:checkoutId/hold',
    idempotencyMiddleware({ required: true }),
    asyncHandler(async (req, res) => {
        const { checkoutId } = req.params;

        const checkout = await checkoutService.createHold(checkoutId);

        res.json({
            checkoutId: checkout.checkoutId,
            state: checkout.state,
            staysReservationId: checkout.staysReservationId,
            holdExpiresAt: checkout.holdExpiresAt,
        });
    }),
);

/**
 * POST /checkout/:checkoutId/payment-intent
 * Create Stripe PaymentIntent - TRANSACTIONAL
 * 
 * Must be called AFTER creating hold
 * Returns client_secret for Stripe Elements (NOT stored in DB)
 */
router.post('/:checkoutId/payment-intent',
    idempotencyMiddleware({ required: true }),
    asyncHandler(async (req, res) => {
        const { checkoutId } = req.params;

        const result = await checkoutService.createPaymentIntent(checkoutId);

        // NOTE: client_secret is returned here but NOT persisted (security)
        res.json({
            checkoutId,
            clientSecret: result.clientSecret,
            state: result.state,
        });
    }),
);

/**
 * POST /checkout/:checkoutId/finalize
 * Called by frontend after payment confirmation
 * 
 * This polls for webhook confirmation and returns booking details
 * (Implements the "finalize" recommendation for better UX)
 */
router.post('/:checkoutId/finalize',
    validate(finalizeCheckoutSchema),
    asyncHandler(async (req, res) => {
        const { checkoutId } = req.params;
        const { maxWaitMs = 10000 } = req.body;

        // Poll for BOOKED state (webhook may have already arrived)
        const checkout = await checkoutService.waitForConfirmation(
            checkoutId,
            Math.min(maxWaitMs, 30000), // Cap at 30 seconds
        );

        if (checkout.state === CheckoutState.BOOKED) {
            res.json({
                success: true,
                bookingCode: checkout.staysBookingCode,
                checkout,
            });
        } else if (checkout.state === CheckoutState.PAID) {
            // Payment confirmed but Stays update pending
            res.json({
                success: true,
                pending: true,
                message: 'Pagamento confirmado. Finalizando sua reserva...',
                checkout,
            });
        } else {
            // Unexpected state
            res.json({
                success: false,
                message: 'Não foi possível confirmar o pagamento. Entre em contato com o suporte.',
                checkout,
            });
        }
    }),
);

/**
 * POST /checkout/:checkoutId/cancel
 * Cancel a checkout (user-initiated)
 */
router.post('/:checkoutId/cancel',
    asyncHandler(async (req, res) => {
        const { checkoutId } = req.params;
        const { reason } = req.body;

        const checkout = await checkoutService.cancelCheckout(checkoutId, reason);

        res.json({
            checkoutId,
            state: checkout.state,
            canceled: true,
        });
    }),
);

export default router;
