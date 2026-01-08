/**
 * Structured Logger for Vivare API
 * Always includes checkoutId for correlation when available
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
    checkoutId?: string;
    staysReservationId?: string;
    stripePaymentIntentId?: string;
    state?: string;
    latencyMs?: number;
    [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const currentLevel = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || 'info'];

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= currentLevel;
}

function formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}`;
}

export const logger = {
    debug(message: string, context?: LogContext): void {
        if (shouldLog('debug')) {
            console.debug(formatMessage('debug', message, context));
        }
    },

    info(message: string, context?: LogContext): void {
        if (shouldLog('info')) {
            console.info(formatMessage('info', message, context));
        }
    },

    warn(message: string, context?: LogContext): void {
        if (shouldLog('warn')) {
            console.warn(formatMessage('warn', message, context));
        }
    },

    error(message: string, error?: Error | unknown, context?: LogContext): void {
        if (shouldLog('error')) {
            const errorDetails = error instanceof Error
                ? { errorMessage: error.message, stack: error.stack }
                : { errorDetails: error };
            console.error(formatMessage('error', message, { ...context, ...errorDetails }));
        }
    },

    /**
     * Create a child logger with preset context (e.g., checkoutId)
     */
    child(baseContext: LogContext) {
        return {
            debug: (msg: string, ctx?: LogContext) => logger.debug(msg, { ...baseContext, ...ctx }),
            info: (msg: string, ctx?: LogContext) => logger.info(msg, { ...baseContext, ...ctx }),
            warn: (msg: string, ctx?: LogContext) => logger.warn(msg, { ...baseContext, ...ctx }),
            error: (msg: string, err?: Error | unknown, ctx?: LogContext) =>
                logger.error(msg, err, { ...baseContext, ...ctx }),
        };
    },
};
