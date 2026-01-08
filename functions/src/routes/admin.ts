import { Router, Request, Response, NextFunction } from 'express';
import { asyncHandler, Errors } from '../middleware/error-handler.js';
import { collections, admin } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Admin authentication middleware
 * Verifies Firebase ID token and checks role
 */
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing authorization' });
        return;
    }

    const idToken = authHeader.substring(7);

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);

        // Check role claim (set via Firebase Admin custom claims)
        const role = decodedToken.role as string | undefined;

        if (!role || !['admin', 'editor', 'support'].includes(role)) {
            throw Errors.forbidden('Insufficient permissions');
        }

        // Attach user to request
        (req as Request & { user: typeof decodedToken }).user = decodedToken;

        next();
    } catch (error) {
        logger.warn('Admin auth failed', { error: (error as Error).message });
        res.status(401).json({ error: 'Invalid token' });
    }
}

// Apply admin auth to all routes
router.use(requireAdmin);

// ============================================
// Content Management
// ============================================

/**
 * GET /admin/content/:key
 * Get editable content by key
 */
router.get('/content/:key', asyncHandler(async (req, res) => {
    const { key } = req.params;

    const doc = await collections.content.doc(key).get();

    if (!doc.exists) {
        throw Errors.notFound('Content');
    }

    res.json(doc.data());
}));

/**
 * PUT /admin/content/:key
 * Update editable content
 */
router.put('/content/:key', asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { content } = req.body;

    await collections.content.doc(key).set({
        ...content,
        updatedAt: new Date(),
        updatedBy: (req as Request & { user: { uid: string } }).user.uid,
    }, { merge: true });

    res.json({ success: true });
}));

/**
 * GET /admin/content
 * List all editable content keys
 */
router.get('/content', asyncHandler(async (_req, res) => {
    const snapshot = await collections.content.get();

    const items = snapshot.docs.map(doc => ({
        key: doc.id,
        ...doc.data(),
    }));

    res.json(items);
}));

// ============================================
// Home Page Editor
// ============================================

/**
 * GET /admin/home
 * Get home page configuration
 */
router.get('/home', asyncHandler(async (_req, res) => {
    const doc = await collections.content.doc('home').get();

    res.json(doc.exists ? doc.data() : {
        hero: {
            headline: 'Hospede-se com estilo em São Paulo',
            subheadline: 'Apartamentos premium para estadias curtas',
        },
        sections: {
            featured: { visible: true, order: 1 },
            howItWorks: { visible: true, order: 2 },
            collections: { visible: true, order: 3 },
            testimonials: { visible: true, order: 4 },
        },
    });
}));

/**
 * PUT /admin/home
 * Update home page configuration
 */
router.put('/home', asyncHandler(async (req, res) => {
    const { hero, sections, ctas } = req.body;

    await collections.content.doc('home').set({
        hero,
        sections,
        ctas,
        updatedAt: new Date(),
        updatedBy: (req as Request & { user: { uid: string } }).user.uid,
    }, { merge: true });

    res.json({ success: true });
}));

// ============================================
// FAQ Management
// ============================================

/**
 * GET /admin/faq
 * List all FAQ items
 */
router.get('/faq', asyncHandler(async (_req, res) => {
    const snapshot = await collections.content
        .doc('faq')
        .collection('items')
        .orderBy('order')
        .get();

    const items = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
    }));

    res.json(items);
}));

/**
 * POST /admin/faq
 * Create FAQ item
 */
router.post('/faq', asyncHandler(async (req, res) => {
    const { question, answer, category, order } = req.body;

    const docRef = await collections.content
        .doc('faq')
        .collection('items')
        .add({
            question,
            answer,
            category,
            order: order ?? 0,
            createdAt: new Date(),
        });

    res.status(201).json({ id: docRef.id });
}));

/**
 * PUT /admin/faq/:id
 * Update FAQ item
 */
router.put('/faq/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { question, answer, category, order } = req.body;

    await collections.content
        .doc('faq')
        .collection('items')
        .doc(id)
        .update({
            question,
            answer,
            category,
            order,
            updatedAt: new Date(),
        });

    res.json({ success: true });
}));

/**
 * DELETE /admin/faq/:id
 * Delete FAQ item
 */
router.delete('/faq/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;

    await collections.content
        .doc('faq')
        .collection('items')
        .doc(id)
        .delete();

    res.json({ success: true });
}));

// ============================================
// Campaign Banners
// ============================================

/**
 * GET /admin/banners
 * List all banners
 */
router.get('/banners', asyncHandler(async (_req, res) => {
    const snapshot = await collections.content
        .doc('banners')
        .collection('items')
        .get();

    const items = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
    }));

    res.json(items);
}));

/**
 * POST /admin/banners
 * Create banner
 */
router.post('/banners', asyncHandler(async (req, res) => {
    const { title, message, cta, ctaUrl, active, startDate, endDate } = req.body;

    const docRef = await collections.content
        .doc('banners')
        .collection('items')
        .add({
            title,
            message,
            cta,
            ctaUrl,
            active: active ?? false,
            startDate,
            endDate,
            createdAt: new Date(),
        });

    res.status(201).json({ id: docRef.id });
}));

/**
 * PUT /admin/banners/:id
 * Update banner
 */
router.put('/banners/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;

    await collections.content
        .doc('banners')
        .collection('items')
        .doc(id)
        .update({
            ...req.body,
            updatedAt: new Date(),
        });

    res.json({ success: true });
}));

// ============================================
// Checkout Dashboard (read-only)
// ============================================

/**
 * GET /admin/checkouts
 * List checkouts with filters
 */
router.get('/checkouts', asyncHandler(async (req, res) => {
    const { state, limit = '50', offset = '0' } = req.query;

    let query = collections.checkouts
        .orderBy('createdAt', 'desc')
        .limit(parseInt(limit as string, 10))
        .offset(parseInt(offset as string, 10));

    if (state) {
        query = query.where('state', '==', state);
    }

    const snapshot = await query.get();

    const checkouts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
    }));

    res.json(checkouts);
}));

/**
 * GET /admin/checkouts/failed
 * Get failed/expired checkouts for dashboard
 */
router.get('/checkouts/failed', asyncHandler(async (_req, res) => {
    const snapshot = await collections.checkouts
        .where('state', 'in', ['EXPIRED', 'FAILED', 'CANCELED'])
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();

    const checkouts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
    }));

    res.json(checkouts);
}));

/**
 * GET /admin/checkouts/:id
 * Get checkout details with full history
 */
router.get('/checkouts/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;

    const doc = await collections.checkouts.doc(id).get();

    if (!doc.exists) {
        throw Errors.notFound('Checkout');
    }

    res.json(doc.data());
}));

export default router;
