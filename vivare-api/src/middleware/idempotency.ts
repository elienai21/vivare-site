import { Request, Response, NextFunction } from 'express';
import { collections } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';

/**
 * Idempotency Middleware
 * 
 * Uses Idempotency-Key header to prevent duplicate processing.
 * Stores processed keys in Firestore for durability across instances.
 * 
 * IMPORTANT: This is mandatory for all transactional endpoints
 * (checkout creation, hold creation, payment processing, webhooks)
 */

const IDEMPOTENCY_COLLECTION = 'idempotency_keys';
const DEFAULT_TTL_HOURS = 24;

interface IdempotencyRecord {
    key: string;
    endpoint: string;
    method: string;
    responseStatus: number;
    responseBody: unknown;
    createdAt: Date;
    expiresAt: Date;
}

/**
 * Extend Express Request to include idempotency key
 */
declare global {
    namespace Express {
        interface Request {
            idempotencyKey?: string;
        }
    }
}

/**
 * Idempotency middleware factory
 * 
 * @param options.required - If true, returns 400 if header is missing
 * @param options.ttlHours - How long to keep idempotency records
 */
export function idempotencyMiddleware(options: { required?: boolean; ttlHours?: number } = {}) {
    const { required = false, ttlHours = DEFAULT_TTL_HOURS } = options;

    return async (req: Request, res: Response, next: NextFunction) => {
        const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

        if (!idempotencyKey) {
            if (required) {
                res.status(400).json({
                    error: 'Missing Idempotency-Key header',
                    code: 'IDEMPOTENCY_KEY_REQUIRED',
                });
                return;
            }
            // If not required, just proceed without idempotency
            next();
            return;
        }

        req.idempotencyKey = idempotencyKey;

        const endpoint = `${req.method}:${req.path}`;
        const docRef = collections.checkouts.firestore
            .collection(IDEMPOTENCY_COLLECTION)
            .doc(`${endpoint}:${idempotencyKey}`);

        try {
            const doc = await docRef.get();

            if (doc.exists) {
                const record = doc.data() as IdempotencyRecord;

                // Check if expired
                if (new Date() > record.expiresAt) {
                    // Expired, allow re-processing
                    await docRef.delete();
                } else {
                    // Return cached response
                    logger.info('Idempotent request - returning cached response', {
                        idempotencyKey,
                        endpoint,
                    });

                    res.status(record.responseStatus).json(record.responseBody);
                    return;
                }
            }

            // Store the response after it's sent
            const originalJson = res.json.bind(res);
            res.json = function (body: unknown) {
                // Store the response for future idempotent requests
                const record: IdempotencyRecord = {
                    key: idempotencyKey,
                    endpoint,
                    method: req.method,
                    responseStatus: res.statusCode,
                    responseBody: body,
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
                };

                docRef.set(record).catch((err) => {
                    logger.error('Failed to store idempotency record', err, { idempotencyKey });
                });

                return originalJson(body);
            };

            next();
        } catch (error) {
            logger.error('Idempotency middleware error', error);
            // On error, proceed without idempotency (fail open)
            next();
        }
    };
}

/**
 * Webhook-specific idempotency using event IDs
 * Uses event ID as idempotency key (e.g., Stripe event ID)
 */
export async function checkWebhookIdempotency(eventId: string): Promise<{
    processed: boolean;
    markProcessed: () => Promise<void>;
}> {
    const docRef = collections.webhookEvents.doc(eventId);

    const doc = await docRef.get();

    if (doc.exists) {
        return {
            processed: true,
            markProcessed: async () => { },
        };
    }

    return {
        processed: false,
        markProcessed: async () => {
            await docRef.set({
                eventId,
                processedAt: new Date(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            });
        },
    };
}
