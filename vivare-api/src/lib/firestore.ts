import * as admin from 'firebase-admin';
import { Firestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin (uses GOOGLE_APPLICATION_CREDENTIALS env var in production)
if (!admin.apps.length) {
    admin.initializeApp({
        projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });
}

export const firestore: Firestore = admin.firestore();

// Collection references
export const collections = {
    checkouts: firestore.collection('checkouts'),
    webhookEvents: firestore.collection('webhook_events'),
    content: firestore.collection('content'),
} as const;

export { admin };
