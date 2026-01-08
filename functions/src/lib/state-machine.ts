import { Timestamp } from 'firebase-admin/firestore';
import { collections } from '../lib/firestore.js';
import {
    Checkout,
    CheckoutState,
    StateTransition,
    isValidTransition,
    isTerminal,
} from '../models/checkout.js';
import { logger } from '../lib/logger.js';

/**
 * State Machine for Checkout
 * 
 * Provides atomic state transitions with Firestore transactions
 * to ensure idempotency and prevent race conditions.
 */

export class StateMachineError extends Error {
    constructor(
        message: string,
        public readonly checkoutId: string,
        public readonly currentState: CheckoutState,
        public readonly targetState: CheckoutState,
    ) {
        super(message);
        this.name = 'StateMachineError';
    }
}

interface TransitionOptions {
    reason?: string;
    actor: 'user' | 'system' | 'webhook';
    /** Additional fields to update along with state */
    updates?: Partial<Omit<Checkout, 'state' | 'stateHistory' | 'updatedAt'>>;
}

/**
 * Transition checkout to a new state using Firestore transaction
 * 
 * This is ATOMIC and IDEMPOTENT:
 * - If already in target state, returns current document (no-op)
 * - If transition is invalid, throws StateMachineError
 * - Uses transaction to prevent race conditions
 * 
 * @returns Updated checkout document
 */
export async function transitionState(
    checkoutId: string,
    targetState: CheckoutState,
    options: TransitionOptions,
): Promise<Checkout> {
    const log = logger.child({ checkoutId, targetState });

    const docRef = collections.checkouts.doc(checkoutId);

    return collections.checkouts.firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);

        if (!doc.exists) {
            throw new Error(`Checkout ${checkoutId} not found`);
        }

        const checkout = doc.data() as Checkout;
        const currentState = checkout.state;

        // Idempotency: if already in target state, return as-is
        if (currentState === targetState) {
            log.info('State transition skipped (already in target state)', {
                state: currentState
            });
            return checkout;
        }

        // Validate transition
        if (!isValidTransition(currentState, targetState)) {
            throw new StateMachineError(
                `Invalid state transition from ${currentState} to ${targetState}`,
                checkoutId,
                currentState,
                targetState,
            );
        }

        // Prevent transitions from terminal states
        if (isTerminal(currentState)) {
            throw new StateMachineError(
                `Cannot transition from terminal state ${currentState}`,
                checkoutId,
                currentState,
                targetState,
            );
        }

        const now = Timestamp.now();

        const transition: StateTransition = {
            from: currentState,
            to: targetState,
            timestamp: now,
            reason: options.reason,
            actor: options.actor,
        };

        const updateData: Partial<Checkout> = {
            ...options.updates,
            state: targetState,
            stateHistory: [...checkout.stateHistory, transition],
            updatedAt: now,
        };

        transaction.update(docRef, updateData);

        log.info('State transition completed', {
            state: targetState,
            previousState: currentState,
            latencyMs: Date.now() - now.toMillis(),
        });

        return {
            ...checkout,
            ...updateData,
        } as Checkout;
    });
}

/**
 * Safely attempt a state transition, catching errors
 * Returns null if transition failed
 */
export async function tryTransitionState(
    checkoutId: string,
    targetState: CheckoutState,
    options: TransitionOptions,
): Promise<Checkout | null> {
    try {
        return await transitionState(checkoutId, targetState, options);
    } catch (error) {
        if (error instanceof StateMachineError) {
            logger.warn('State transition failed', {
                checkoutId,
                currentState: error.currentState,
                targetState: error.targetState,
            });
            return null;
        }
        throw error;
    }
}

/**
 * Get current checkout state
 */
export async function getCheckoutState(checkoutId: string): Promise<CheckoutState | null> {
    const doc = await collections.checkouts.doc(checkoutId).get();
    if (!doc.exists) return null;
    return (doc.data() as Checkout).state;
}
