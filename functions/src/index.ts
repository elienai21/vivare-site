import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import listingsRouter from './routes/listings.js';
import checkoutRouter from './routes/checkout.js';
import webhooksRouter from './routes/webhooks.js';
import jobsRouter from './routes/jobs.js';
import adminRouter from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================
// Security & Performance Middleware
// ============================================

// CORS configuration
const corsOrigins = process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'];
app.use(cors({
    origin: corsOrigins,
    credentials: true,
}));

// Security headers
app.use(helmet());

// Compression
app.use(compression());

// ============================================
// Body Parsing
// Note: Raw body is needed for Stripe webhook signature verification
// ============================================

// For webhooks: need raw body
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

// For all other routes: JSON parsing
app.use(express.json({ limit: '1mb' }));

// ============================================
// Request Logging
// ============================================

app.use((req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const level = res.statusCode >= 400 ? 'warn' : 'debug';

        logger[level](`${req.method} ${req.path}`, {
            statusCode: res.statusCode,
            latencyMs: duration,
            userAgent: req.headers['user-agent'],
        });
    });

    next();
});

// ============================================
// Health Check
// ============================================

app.get('/health', (_req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
    });
});

// ============================================
// API Routes
// ============================================

// Public read APIs (cacheable)
app.use('/listings', listingsRouter);

// Checkout flow (transactional)
app.use('/checkout', checkoutRouter);

// Webhooks (Stripe, Stays)
app.use('/webhooks', webhooksRouter);

// Background jobs (Cloud Scheduler)
app.use('/jobs', jobsRouter);

// Admin CMS APIs
app.use('/admin', adminRouter);

// ============================================
// Error Handling
// ============================================

app.use(notFoundHandler);
app.use(errorHandler);

// ============================================
// Server Start
// ============================================

app.listen(PORT, () => {
    logger.info(`Vivare API running on port ${PORT}`, {
        env: process.env.NODE_ENV || 'development',
    });
});

export default app;
