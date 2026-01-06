import { Router } from 'express';
import { asyncHandler, Errors } from '../middleware/error-handler.js';
import { getStaysClient } from '../services/stays-client.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * GET /listings
 * Search listings with filters
 */
router.get('/', asyncHandler(async (req, res) => {
    const {
        checkIn, checkOut, guests, city, neighborhood,
        minPrice, maxPrice, amenities, bedrooms, groupId,
        limit = '20', offset = '0',
    } = req.query;

    const staysClient = getStaysClient();

    const results = await staysClient.searchListings({
        checkIn: checkIn as string,
        checkOut: checkOut as string,
        guests: guests ? parseInt(guests as string, 10) : undefined,
        city: city as string,
        neighborhood: neighborhood as string,
        minPrice: minPrice ? parseFloat(minPrice as string) : undefined,
        maxPrice: maxPrice ? parseFloat(maxPrice as string) : undefined,
        amenities: amenities ? (amenities as string).split(',') : undefined,
        bedrooms: bedrooms ? parseInt(bedrooms as string, 10) : undefined,
        groupId: groupId as string,
        limit: parseInt(limit as string, 10),
        offset: parseInt(offset as string, 10),
    });

    // Set cache headers (15-120 seconds for availability data)
    res.set('Cache-Control', 'public, max-age=60, s-maxage=120');

    res.json(results);
}));

/**
 * GET /listings/:id
 * Get listing detail
 */
router.get('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;

    const staysClient = getStaysClient();

    try {
        const listing = await staysClient.getListingDetail(id);

        // Longer cache for detail (less volatile)
        res.set('Cache-Control', 'public, max-age=300, s-maxage=600');

        res.json(listing);
    } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) {
            throw Errors.notFound('Listing');
        }
        throw error;
    }
}));

/**
 * GET /listings/:id/calendar
 * Get availability calendar with flags
 */
router.get('/:id/calendar', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        throw Errors.badRequest('startDate and endDate are required');
    }

    const staysClient = getStaysClient();

    const calendar = await staysClient.getListingCalendar(
        id,
        startDate as string,
        endDate as string,
    );

    // Short cache for calendar (availability can change)
    res.set('Cache-Control', 'public, max-age=15, s-maxage=60');

    res.json(calendar);
}));

/**
 * POST /listings/calculate-price
 * Calculate price for a potential booking
 */
router.post('/calculate-price', asyncHandler(async (req, res) => {
    const { listingId, checkIn, checkOut, guests, couponCode } = req.body;

    if (!listingId || !checkIn || !checkOut || !guests) {
        throw Errors.badRequest('Missing required fields: listingId, checkIn, checkOut, guests');
    }

    const staysClient = getStaysClient();

    const price = await staysClient.calculatePrice({
        listingId,
        checkIn,
        checkOut,
        guests,
        couponCode,
    });

    logger.debug('Price calculated', {
        listingId,
        checkIn,
        checkOut,
        guests,
        total: price.total,
        currency: price.currency,
    });

    // Short cache
    res.set('Cache-Control', 'private, max-age=30');

    res.json(price);
}));

/**
 * GET /listings/groups
 * Get all listing groups (collections)
 */
router.get('/groups', asyncHandler(async (_req, res) => {
    const staysClient = getStaysClient();
    const groups = await staysClient.getGroups();

    res.set('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.json(groups);
}));

/**
 * GET /listings/groups/:idOrSlug
 * Get a specific group with its listings
 */
router.get('/groups/:idOrSlug', asyncHandler(async (req, res) => {
    const { idOrSlug } = req.params;

    const staysClient = getStaysClient();
    const group = await staysClient.getGroup(idOrSlug);

    res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.json(group);
}));

export default router;
