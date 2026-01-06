/**
 * Stays.net External API Types
 * Based on Stays External API Documentation
 */

// ============================================
// Listings
// ============================================

export interface StaysListing {
    _id: string;
    internalName: string;
    publicName: string;
    status: 'active' | 'inactive' | 'archived';
    address: {
        street?: string;
        number?: string;
        complement?: string;
        neighborhood?: string;
        city: string;
        state: string;
        country: string;
        zipCode?: string;
        coordinates?: {
            latitude: number;
            longitude: number;
        };
    };
    bedrooms: number;
    bathrooms: number;
    maxGuests: number;
    propertyType: string;
    amenities: string[];
    photos: StaysPhoto[];
    description?: string;
    houseRules?: string;
    checkInTime?: string;
    checkOutTime?: string;
    customFields?: Record<string, unknown>;
    groups?: string[]; // Group IDs for collections
}

export interface StaysPhoto {
    _id: string;
    url: string;
    order: number;
    caption?: string;
}

export interface StaysListingDetail extends StaysListing {
    // Extended detail fields
    cancellationPolicy?: {
        type: string;
        description: string;
    };
    pricing?: {
        basePrice: number;
        currency: string;
        cleaningFee?: number;
    };
}

// ============================================
// Calendar
// ============================================

export interface StaysCalendarDay {
    date: string; // YYYY-MM-DD
    avail: number; // 0 = blocked, 1+ = available
    price?: number;
    minStay?: number;
    closedToArrival?: boolean;
    closedToDeparture?: boolean;
}

export interface StaysCalendarResponse {
    listingId: string;
    calendar: StaysCalendarDay[];
}

// ============================================
// Price Calculation
// ============================================

export interface StaysPriceRequest {
    listingId: string;
    checkIn: string; // YYYY-MM-DD
    checkOut: string; // YYYY-MM-DD
    guests: number;
    couponCode?: string;
}

export interface StaysPriceResponse {
    listingId: string;
    checkIn: string;
    checkOut: string;
    nights: number;
    guests: number;
    subtotal: number;
    cleaningFee: number;
    serviceFee: number;
    taxes: number;
    total: number;
    currency: string;
    breakdown?: {
        nightlyRates: Array<{
            date: string;
            price: number;
        }>;
    };
}

// ============================================
// Reservations
// ============================================

export type ReservationType = 'reserved' | 'booked' | 'canceled';

export interface StaysGuest {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    document?: string;
}

export interface StaysReservationCreate {
    listingId: string;
    checkIn: string;
    checkOut: string;
    guests: number;
    type: 'reserved' | 'booked';
    guest: StaysGuest;
    source?: string;
    totalPrice: number;
    currency: string;
    notes?: string;
}

export interface StaysReservation {
    _id: string;
    code: string; // Guest-facing booking code
    listingId: string;
    checkIn: string;
    checkOut: string;
    guests: number;
    type: ReservationType;
    status: string;
    guest: StaysGuest;
    pricing: {
        total: number;
        currency: string;
        paid: number;
        balance: number;
    };
    createdAt: string;
    updatedAt: string;
}

export interface StaysReservationUpdate {
    type?: ReservationType;
    guest?: Partial<StaysGuest>;
    notes?: string;
}

// ============================================
// Payments
// ============================================

export interface StaysPaymentCreate {
    amount: number;
    currency: string;
    method: 'credit_card' | 'pix' | 'bank_transfer' | 'other';
    reference?: string; // e.g., Stripe PaymentIntent ID
    notes?: string;
}

export interface StaysPayment {
    _id: string;
    reservationId: string;
    amount: number;
    currency: string;
    method: string;
    status: 'pending' | 'confirmed' | 'refunded';
    reference?: string;
    createdAt: string;
}

// ============================================
// Groups (Collections)
// ============================================

export interface StaysGroup {
    _id: string;
    name: string;
    slug: string;
    description?: string;
    listings: string[]; // Listing IDs
}

// ============================================
// Search & Filters
// ============================================

export interface StaysSearchFilters {
    checkIn?: string;
    checkOut?: string;
    guests?: number;
    city?: string;
    neighborhood?: string;
    minPrice?: number;
    maxPrice?: number;
    amenities?: string[];
    bedrooms?: number;
    groupId?: string;
    limit?: number;
    offset?: number;
}

export interface StaysSearchResponse {
    listings: StaysListing[];
    total: number;
    limit: number;
    offset: number;
}

// ============================================
// API Error
// ============================================

export interface StaysApiError {
    code: string;
    message: string;
    details?: unknown;
}
