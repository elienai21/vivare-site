import { z } from 'zod';

// Helper for date validation
const futureDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato inválido (AAAA-MM-DD)').refine((val) => {
    const date = new Date(val);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date >= today;
}, { message: 'A data deve ser hoje ou no futuro' });

export const initializeCheckoutSchema = z.object({
    body: z.object({
        listingId: z.string().min(1, 'Listing ID is required'),
        checkIn: futureDate,
        checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato inválido (AAAA-MM-DD)'),
        guests: z.object({
            adults: z.number().int().min(1, 'Pelo menos um adulto é necessário'),
            children: z.number().int().nonnegative().optional(),
            infants: z.number().int().nonnegative().optional(),
        }),
        couponCode: z.string().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
    }).refine((data) => {
        const checkIn = new Date(data.checkIn);
        const checkOut = new Date(data.checkOut);
        return checkOut > checkIn;
    }, {
        message: 'A data de check-out deve ser após o check-in',
        path: ['checkOut']
    })
});

export const updateGuestSchema = z.object({
    params: z.object({
        checkoutId: z.string().min(1, 'Checkout ID is required'),
    }),
    body: z.object({
        guest: z.object({
            firstName: z.string().min(1, 'Nome é obrigatório'),
            lastName: z.string().min(1, 'Sobrenome é obrigatório'),
            email: z.string().email('E-mail inválido'),
            phone: z.string().regex(/^\+?[\d\s-]{8,}$/, 'Telefone inválido'),
            document: z.string().min(5, 'Documento é obrigatório'),
        })
    })
});

export const finalizeCheckoutSchema = z.object({
    params: z.object({
        checkoutId: z.string().min(1, 'Checkout ID is required'),
    }),
    body: z.object({
        maxWaitMs: z.number().int().min(1000).max(30000).optional(),
    })
});
