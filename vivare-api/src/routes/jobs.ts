import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { CheckoutService } from '../services/checkout-service.js';

const router = Router();
const checkoutService = new CheckoutService();

/**
 * Middleware to verify Cloud Scheduler service account
 * In production, this should verify the OIDC token from Cloud Scheduler
 */
function requireServiceAccount(req: Request, res: Response, next: () => void) {
    // In development, allow without auth
    if (process.env.NODE_ENV === 'development') {
        next();
        return;
    }

    // In production, verify the Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing authorization' });
        return;
    }

    // TODO: Verify OIDC token from Cloud Scheduler
    // For now, check for a shared secret (less secure but simpler)
    const token = authHeader.substring(7);
    const expectedToken = process.env.JOB_AUTH_TOKEN;

    if (!expectedToken || token !== expectedToken) {
        res.status(403).json({ error: 'Invalid authorization' });
        return;
    }

    next();
}

/**
 * POST /jobs/expire-holds
 * Background job to expire stale holds
 * 
 * Called by Cloud Scheduler every 2-5 minutes
 * 
 * Process:
 * 1. Query checkouts in HOLD_CREATED or PAYMENT_CREATED state
 * 2. Filter those where holdExpiresAt < now
 * 3. For each: cancel Stays reservation, transition to EXPIRED
 */
router.post('/expire-holds', requireServiceAccount, async (_req: Request, res: Response) => {
    const startTime = Date.now();

    logger.info('Starting expire-holds job');

    try {
        const result = await checkoutService.expireHolds();

        const latencyMs = Date.now() - startTime;

        logger.info('Expire-holds job completed', {
            expiredCount: result.expiredCount,
            errorCount: result.errorCount,
            latencyMs,
        });

        res.json({
            success: true,
            expiredCount: result.expiredCount,
            errorCount: result.errorCount,
            latencyMs,
        });

    } catch (error) {
        logger.error('Expire-holds job failed', error);

        res.status(500).json({
            success: false,
            error: (error as Error).message,
        });
    }
});

/**
 * POST /jobs/cleanup-idempotency
 * Cleanup expired idempotency keys
 * 
 * Called by Cloud Scheduler once daily
 */
router.post('/cleanup-idempotency', requireServiceAccount, async (_req: Request, res: Response) => {
    const startTime = Date.now();

    logger.info('Starting cleanup-idempotency job');

    try {
        // TODO: Implement cleanup of expired idempotency keys
        // Query idempotency_keys and webhook_events where expiresAt < now
        // Delete in batches

        const latencyMs = Date.now() - startTime;

        logger.info('Cleanup-idempotency job completed', { latencyMs });

        res.json({
            success: true,
            latencyMs,
        });

    } catch (error) {
        logger.error('Cleanup-idempotency job failed', error);

        res.status(500).json({
            success: false,
            error: (error as Error).message,
        });
    }
});

/**
 * GET /jobs/health
 * Health check for background job runner
 */
router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy' });
});

export default router;
