/**
 * Manual Payment Adapter
 * For cash, check, Zelle, and other manual payment methods
 */

import { Effect } from 'effect';
import type {
  SchedulingResult,
  PaymentIntent,
  PaymentResult,
  RefundResult,
} from '../core/types.js';
import { Errors } from '../core/types.js';
import { generateId } from '../core/utils.js';
import type {
  PaymentAdapter,
  PaymentWebhookEvent,
  PaymentClientConfig,
  ManualPaymentConfig,
} from './types.js';

// =============================================================================
// MANUAL PAYMENT ADAPTER
// =============================================================================

/**
 * Manual payment adapter for cash, check, Zelle, etc.
 * These payments are tracked but not processed automatically.
 */
export const createManualPaymentAdapter = (
  config: ManualPaymentConfig,
  methodName: string = 'manual',
  displayName: string = 'Pay Later'
): PaymentAdapter => {
  return {
    name: methodName,
    displayName,
    icon: 'cash',

    isAvailable: () => Effect.succeed(config.methods.length > 0),

    createIntent: ({ amount, currency, description, idempotencyKey }) => {
      const intent: PaymentIntent = {
        id: `manual_${generateId()}`,
        amount,
        currency,
        status: 'pending',
        processor: methodName,
        processorTransactionId: undefined,
        metadata: { description },
        createdAt: new Date().toISOString(),
        // Manual payments don't expire
      };

      return Effect.succeed(intent);
    },

    capturePayment: (intentId) => {
      // Manual payments are "captured" immediately with pending status
      // The actual payment collection happens outside the system
      const result: PaymentResult = {
        success: true,
        transactionId: `${intentId}_pending`,
        processor: methodName,
        amount: 0, // Amount will be in the booking notes
        currency: 'USD',
        timestamp: new Date().toISOString(),
        metadata: {
          status: 'pending_collection',
          note: 'Payment to be collected at appointment',
        },
      };

      return Effect.succeed(result);
    },

    cancelIntent: () => Effect.succeed(undefined),

    refund: ({ transactionId }) => {
      // Manual refunds are just recorded, not processed
      const result: RefundResult = {
        success: true,
        refundId: `refund_${generateId()}`,
        originalTransactionId: transactionId,
        amount: 0,
        currency: 'USD',
        timestamp: new Date().toISOString(),
      };

      return Effect.succeed(result);
    },

    verifyWebhook: () => Effect.succeed(true), // No webhooks for manual

    parseWebhook: () =>
      Effect.fail(Errors.payment('NO_WEBHOOKS', 'Manual payments do not support webhooks', methodName, false)),

    getClientConfig: () => ({
      name: methodName,
      displayName,
      icon: 'cash',
      environment: 'production' as const,
      supportedCurrencies: ['USD'],
      instructions: config.instructions,
    }),
  };
};

// =============================================================================
// SPECIFIC MANUAL PAYMENT TYPES
// =============================================================================

export const createCashAdapter = (): PaymentAdapter =>
  createManualPaymentAdapter(
    {
      type: 'manual',
      methods: ['cash'],
      instructions: {
        cash: 'Payment will be collected at your appointment.',
      },
    },
    'cash',
    'Pay with Cash'
  );

export const createZelleAdapter = (zelleEmail: string): PaymentAdapter =>
  createManualPaymentAdapter(
    {
      type: 'manual',
      methods: ['zelle'],
      instructions: {
        zelle: `Send Zelle payment to: ${zelleEmail}`,
      },
    },
    'zelle',
    'Pay with Zelle'
  );

export const createCheckAdapter = (payableTo: string): PaymentAdapter =>
  createManualPaymentAdapter(
    {
      type: 'manual',
      methods: ['check'],
      instructions: {
        check: `Bring check to your appointment. Make payable to: ${payableTo}`,
      },
    },
    'check',
    'Pay by Check'
  );

export const createVenmoDirectAdapter = (
  venmoUsername: string,
  businessName: string,
): PaymentAdapter =>
  createManualPaymentAdapter(
    {
      type: 'manual',
      methods: ['venmo-direct'],
      instructions: {
        'venmo-direct': `Pay via Venmo: venmo.com/${venmoUsername} (${businessName}). Include your appointment date in the note.`,
      },
    },
    'venmo-direct',
    'Pay with Venmo (Direct)'
  );

export type { ManualPaymentConfig };
