import { initializeCheckoutSchema } from '../schemas/checkout-schema';

describe('Checkout Schema Validation', () => {
    const validData = {
        body: {
            listingId: 'listing123',
            checkIn: '2026-01-10',
            checkOut: '2026-01-15',
            guests: {
                adults: 2,
                children: 1
            }
        }
    };

    it('should validate correct data', async () => {
        const result = await initializeCheckoutSchema.safeParseAsync(validData);
        expect(result.success).toBe(true);
    });

    it('should fail if checkIn is in the past', async () => {
        const pastData = {
            ...validData,
            body: { ...validData.body, checkIn: '2020-01-01' }
        };
        const result = await initializeCheckoutSchema.safeParseAsync(pastData);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].message).toBe('A data deve ser hoje ou no futuro');
        }
    });

    it('should fail if checkOut is before checkIn', async () => {
        const invalidDates = {
            ...validData,
            body: { ...validData.body, checkIn: '2026-01-15', checkOut: '2026-01-10' }
        };
        const result = await initializeCheckoutSchema.safeParseAsync(invalidDates);
        expect(result.success).toBe(false);
    });

    it('should fail if guests are invalid', async () => {
        const invalidGuests = {
            ...validData,
            body: { ...validData.body, guests: { adults: 0 } }
        };
        const result = await initializeCheckoutSchema.safeParseAsync(invalidGuests);
        expect(result.success).toBe(false);
    });
});
