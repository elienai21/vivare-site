import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

/**
 * API Error class for structured error responses
 */
export class ApiError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number = 500,
        public readonly code?: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = 'ApiError';
    }

    toJSON() {
        return {
            error: this.message,
            code: this.code,
            details: this.details,
        };
    }
}

/**
 * Common API errors
 */
export const Errors = {
    notFound: (resource: string) =>
        new ApiError(`${resource} not found`, 404, 'NOT_FOUND'),

    badRequest: (message: string, details?: unknown) =>
        new ApiError(message, 400, 'BAD_REQUEST', details),

    unauthorized: (message = 'Unauthorized') =>
        new ApiError(message, 401, 'UNAUTHORIZED'),

    forbidden: (message = 'Forbidden') =>
        new ApiError(message, 403, 'FORBIDDEN'),

    conflict: (message: string) =>
        new ApiError(message, 409, 'CONFLICT'),

    serviceUnavailable: (message = 'Service temporarily unavailable') =>
        new ApiError(message, 503, 'SERVICE_UNAVAILABLE'),

    internal: (message = 'Internal server error') =>
        new ApiError(message, 500, 'INTERNAL_ERROR'),
};

/**
 * Async handler wrapper to catch errors in async route handlers
 */
export function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Global error handler middleware
 */
export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: NextFunction,
): void {
    // Extract checkoutId from request for logging
    const checkoutId = req.params.checkoutId || req.body?.checkoutId;

    if (err instanceof ApiError) {
        logger.warn(`API Error: ${err.message}`, {
            checkoutId,
            statusCode: err.statusCode,
            code: err.code,
            path: req.path,
        });

        res.status(err.statusCode).json(err.toJSON());
        return;
    }

    // Log unexpected errors
    logger.error('Unhandled error', err, {
        checkoutId,
        path: req.path,
        method: req.method,
    });

    // Don't expose internal error details in production
    const message = process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message;

    res.status(500).json({
        error: message,
        code: 'INTERNAL_ERROR',
    });
}

/**
 * Not found handler for unmatched routes
 */
export function notFoundHandler(req: Request, res: Response): void {
    res.status(404).json({
        error: 'Endpoint not found',
        code: 'NOT_FOUND',
        path: req.path,
    });
}
