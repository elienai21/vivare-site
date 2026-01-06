import { logger } from '../lib/logger.js';
import {
    StaysListingDetail,
    StaysCalendarResponse,
    StaysPriceRequest,
    StaysPriceResponse,
    StaysReservationCreate,
    StaysReservation,
    StaysReservationUpdate,
    StaysPaymentCreate,
    StaysPayment,
    StaysSearchFilters,
    StaysSearchResponse,
    StaysGroup,
} from './stays-types.js';

/**
 * Stays.net External API Client
 * 
 * Features:
 * - Retry logic with exponential backoff
 * - Timeout handling (30s default)
 * - Structured logging with correlation IDs
 * - Separated into cacheable (public read) and transactional (never cached) methods
 */

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export class StaysApiError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly code?: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = 'StaysApiError';
    }
}

interface StaysClientConfig {
    baseUrl: string;
    apiKey: string;
    clientId: string;
    timeoutMs?: number;
}

export class StaysClient {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly clientId: string;
    private readonly timeoutMs: number;

    constructor(config: StaysClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
        this.apiKey = config.apiKey;
        this.clientId = config.clientId;
        this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    // ============================================
    // PUBLIC READ APIs (cacheable) - Fast 8s timeout
    // ============================================

    /**
     * Search listings with filters
     */
    async searchListings(filters: StaysSearchFilters = {}): Promise<StaysSearchResponse> {
        const params = new URLSearchParams();
        Object.entries(filters).forEach(([key, value]) => {
            if (value !== undefined) {
                if (Array.isArray(value)) {
                    params.set(key, value.join(','));
                } else {
                    params.set(key, String(value));
                }
            }
        });

        return this.get<StaysSearchResponse>(`/listings?${params.toString()}`, { timeoutMs: 8000, retry: true });
    }

    /**
     * Get listing detail by ID
     */
    async getListingDetail(listingId: string): Promise<StaysListingDetail> {
        return this.get<StaysListingDetail>(`/listings/${listingId}`, { timeoutMs: 8000, retry: true });
    }

    /**
     * Get calendar for a listing (cached)
     */
    async getListingCalendar(
        listingId: string,
        startDate: string,
        endDate: string,
    ): Promise<StaysCalendarResponse> {
        const params = new URLSearchParams({ startDate, endDate });
        return this.get<StaysCalendarResponse>(`/listings/${listingId}/calendar?${params.toString()}`, { timeoutMs: 8000, retry: true });
    }

    /**
     * Calculate price for a booking (cached)
     */
    async calculatePrice(request: StaysPriceRequest): Promise<StaysPriceResponse> {
        return this.post<StaysPriceResponse>('/booking/calculate-price', request, { timeoutMs: 8000, retry: true });
    }

    /**
     * Get all groups (collections)
     */
    async getGroups(): Promise<StaysGroup[]> {
        return this.get<StaysGroup[]>('/groups', { timeoutMs: 5000, retry: true });
    }

    /**
     * Get group by ID or slug
     */
    async getGroup(idOrSlug: string): Promise<StaysGroup> {
        return this.get<StaysGroup>(`/groups/${idOrSlug}`, { timeoutMs: 5000, retry: true });
    }

    // ============================================
    // TRANSACTIONAL APIs (never cached) - Reliable 30s timeout
    // ============================================

    /**
     * Create a new reservation
     * 
     * Use type: 'reserved' for hold, type: 'booked' for confirmed
     */
    async createReservation(data: StaysReservationCreate): Promise<StaysReservation> {
        logger.info('Creating Stays reservation', {
            listingId: data.listingId,
            type: data.type,
            checkIn: data.checkIn,
            checkOut: data.checkOut,
        });

        return this.post<StaysReservation>('/reservations', data, { timeoutMs: 30000, retry: false });
    }

    /**
     * Update a reservation (e.g., reserved → booked)
     */
    async updateReservation(
        reservationId: string,
        updates: StaysReservationUpdate,
    ): Promise<StaysReservation> {
        logger.info('Updating Stays reservation', {
            staysReservationId: reservationId,
            updates,
        });

        return this.patch<StaysReservation>(`/reservations/${reservationId}`, updates, { timeoutMs: 30000, retry: false });
    }

    /**
     * Cancel a reservation
     */
    async cancelReservation(reservationId: string): Promise<void> {
        logger.info('Canceling Stays reservation', { staysReservationId: reservationId });

        await this.patch<StaysReservation>(
            `/reservations/${reservationId}`,
            { type: 'canceled' },
            { timeoutMs: 20000, retry: false },
        );
    }

    /**
     * Get reservation by ID
     */
    async getReservation(reservationId: string): Promise<StaysReservation> {
        return this.get<StaysReservation>(`/reservations/${reservationId}`, { timeoutMs: 15000, retry: true });
    }

    /**
     * Register a payment for a reservation
     */
    async registerPayment(
        reservationId: string,
        payment: StaysPaymentCreate,
    ): Promise<StaysPayment> {
        logger.info('Registering payment in Stays', {
            staysReservationId: reservationId,
            amount: payment.amount,
            currency: payment.currency,
            reference: payment.reference,
        });

        return this.post<StaysPayment>(
            `/reservations/${reservationId}/payments`,
            payment,
            { timeoutMs: 30000, retry: false },
        );
    }

    // ============================================
    // HTTP Methods with retry logic
    // ============================================

    private async get<T>(path: string, options: { retry?: boolean, timeoutMs?: number } = {}): Promise<T> {
        return this.request<T>('GET', path, undefined, options.retry ?? true, options.timeoutMs);
    }

    private async post<T>(
        path: string,
        body: unknown,
        options: { retry?: boolean, timeoutMs?: number } = {},
    ): Promise<T> {
        return this.request<T>('POST', path, body, options.retry ?? true, options.timeoutMs);
    }

    private async patch<T>(
        path: string,
        body: unknown,
        options: { retry?: boolean, timeoutMs?: number } = {},
    ): Promise<T> {
        return this.request<T>('PATCH', path, body, options.retry ?? false, options.timeoutMs);
    }

    private async request<T>(
        method: string,
        path: string,
        body?: unknown,
        retry = true,
        customTimeoutMs?: number
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const timeoutMs = customTimeoutMs ?? this.timeoutMs;
        let lastError: Error | null = null;
        const maxAttempts = retry ? MAX_RETRIES : 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const startTime = Date.now();

                const response = await fetch(url, {
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': this.apiKey,
                        'X-Client-ID': this.clientId,
                    },
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);
                const latencyMs = Date.now() - startTime;

                if (!response.ok) {
                    const errorBody = await response.json().catch(() => ({})) as { message?: string; code?: string; details?: unknown };

                    // Don't retry 4xx errors (client errors)
                    if (response.status >= 400 && response.status < 500) {
                        throw new StaysApiError(
                            errorBody.message || `Stays API error: ${response.status}`,
                            response.status,
                            errorBody.code,
                            errorBody.details,
                        );
                    }

                    // 5xx errors may be retried
                    throw new StaysApiError(
                        errorBody.message || `Stays API error: ${response.status}`,
                        response.status,
                        errorBody.code,
                        errorBody.details,
                    );
                }

                const data = await response.json() as T;

                logger.debug('Stays API request completed', {
                    method,
                    path,
                    latencyMs,
                    attempt,
                });

                return data;
            } catch (error) {
                clearTimeout(timeoutId);
                lastError = error as Error;

                // Don't retry client errors
                if (error instanceof StaysApiError && error.statusCode < 500) {
                    throw error;
                }

                // Don't retry abort (timeout)
                if ((error as Error).name === 'AbortError') {
                    throw new StaysApiError('Stays API request timeout', 408);
                }

                // Retry with exponential backoff
                if (attempt < maxAttempts) {
                    const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                    logger.warn('Stays API request failed, retrying', {
                        method,
                        path,
                        attempt,
                        delay,
                        error: (error as Error).message,
                    });
                    await this.sleep(delay);
                }
            }
        }

        throw lastError ?? new Error('Stays API request failed');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Singleton instance (lazy initialized)
let staysClientInstance: StaysClient | null = null;

export function getStaysClient(): StaysClient {
    if (!staysClientInstance) {
        const baseUrl = process.env.STAYS_API_URL;
        const apiKey = process.env.STAYS_API_KEY;
        const clientId = process.env.STAYS_CLIENT_ID;

        if (!baseUrl || !apiKey || !clientId) {
            throw new Error('Missing required Stays API configuration');
        }

        staysClientInstance = new StaysClient({ baseUrl, apiKey, clientId });
    }
    return staysClientInstance;
}
