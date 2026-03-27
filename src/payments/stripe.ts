/**
 * Stripe Payment Adapter
 * Uses raw fetch() against Stripe REST API (no `stripe` npm dependency).
 * Stripe uses form-encoded bodies with `Authorization: Bearer sk_...`.
 */

import { Effect, pipe } from 'effect';
import type {
  SchedulingResult,
  PaymentIntent,
  PaymentResult,
  RefundResult,
} from '../core/types.js';
import { Errors } from '../core/types.js';
import { fromPromise } from '../core/utils.js';
import type {
  PaymentAdapter,
  PaymentWebhookEvent,
  PaymentClientConfig,
  StripeAdapterConfig,
} from './types.js';

// =============================================================================
// STRIPE API TYPES
// =============================================================================

interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  currency: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action'
    | 'processing' | 'requires_capture' | 'canceled' | 'succeeded';
  client_secret: string;
  description?: string;
  metadata?: Record<string, string>;
  created: number;
  latest_charge?: string;
}

interface StripeRefund {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  status: 'succeeded' | 'pending' | 'failed' | 'canceled';
  payment_intent: string;
  created: number;
}

interface StripeError {
  error: {
    type: string;
    code?: string;
    message: string;
  };
}

// =============================================================================
// STRIPE ADAPTER IMPLEMENTATION
// =============================================================================

export const createStripeAdapter = (config: StripeAdapterConfig): PaymentAdapter => {
  const baseUrl = 'https://api.stripe.com';

  // ---------------------------------------------------------------------------
  // HTTP Client (form-encoded — Stripe doesn't use JSON)
  // ---------------------------------------------------------------------------

  const request = async <T>(
    method: string,
    endpoint: string,
    body?: Record<string, string>,
    idempotencyKey?: string
  ): Promise<T> => {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (config.connectedAccountId) {
      headers['Stripe-Account'] = config.connectedAccountId;
    }

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body ? new URLSearchParams(body).toString() : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let message = `Stripe API error ${response.status}: ${errorBody}`;
      try {
        const parsed = JSON.parse(errorBody) as StripeError;
        message = parsed.error?.message ?? message;
      } catch {
        // Use raw text
      }
      throw new Error(message);
    }

    return response.json() as Promise<T>;
  };

  // ---------------------------------------------------------------------------
  // Transformers
  // ---------------------------------------------------------------------------

  const toPaymentIntent = (pi: StripePaymentIntent): PaymentIntent => ({
    id: pi.id,
    amount: pi.amount,
    currency: pi.currency.toUpperCase(),
    status: pi.status === 'succeeded' ? 'completed'
      : pi.status === 'canceled' ? 'cancelled'
      : pi.status === 'processing' ? 'processing'
      : 'pending',
    processor: 'stripe',
    processorTransactionId: pi.id,
    metadata: {
      clientSecret: pi.client_secret,
      ...(pi.description ? { description: pi.description } : {}),
    },
    createdAt: new Date(pi.created * 1000).toISOString(),
  });

  const toPaymentResult = (pi: StripePaymentIntent): PaymentResult => ({
    success: pi.status === 'succeeded',
    transactionId: pi.latest_charge ?? pi.id,
    processor: 'stripe',
    amount: pi.amount,
    currency: pi.currency.toUpperCase(),
    timestamp: new Date().toISOString(),
  });

  // ---------------------------------------------------------------------------
  // Interface Implementation
  // ---------------------------------------------------------------------------

  return {
    name: 'stripe',
    displayName: 'Credit/Debit Card',
    icon: 'stripe',

    isAvailable: () => Effect.succeed(!!config.secretKey),

    createIntent: ({ amount, currency, description, metadata, idempotencyKey }) =>
      pipe(
        fromPromise(
          () => {
            const params: Record<string, string> = {
              amount: String(amount),
              currency: currency.toLowerCase(),
              'automatic_payment_methods[enabled]': 'true',
            };

            if (description) params.description = description;
            if (metadata) {
              for (const [k, v] of Object.entries(metadata)) {
                params[`metadata[${k}]`] = v;
              }
            }

            return request<StripePaymentIntent>(
              'POST',
              '/v1/payment_intents',
              params,
              idempotencyKey
            );
          },
          (e) => Errors.payment('CREATE_INTENT_FAILED', String(e), 'stripe', true)
        ),
        Effect.map(toPaymentIntent)
      ),

    capturePayment: (intentId) =>
      pipe(
        fromPromise(
          () => request<StripePaymentIntent>('GET', `/v1/payment_intents/${intentId}`),
          (e) => Errors.payment('CAPTURE_FAILED', String(e), 'stripe', false, intentId)
        ),
        Effect.map(toPaymentResult)
      ),

    cancelIntent: (intentId) =>
      pipe(
        fromPromise(
          () => request<StripePaymentIntent>('POST', `/v1/payment_intents/${intentId}/cancel`),
          (e) => Errors.payment('CANCEL_FAILED', String(e), 'stripe', false, intentId)
        ),
        Effect.map(() => undefined)
      ),

    refund: ({ transactionId, amount, reason }) =>
      pipe(
        fromPromise(
          () => {
            const params: Record<string, string> = {
              payment_intent: transactionId,
            };
            if (amount) params.amount = String(amount);
            if (reason) params.reason = 'requested_by_customer';

            return request<StripeRefund>('POST', '/v1/refunds', params);
          },
          (e) => Errors.payment('REFUND_FAILED', String(e), 'stripe', false, transactionId)
        ),
        Effect.map((refund) => ({
          success: refund.status === 'succeeded',
          refundId: refund.id,
          originalTransactionId: transactionId,
          amount: refund.amount,
          currency: refund.currency.toUpperCase(),
          timestamp: new Date(refund.created * 1000).toISOString(),
        }))
      ),

    verifyWebhook: ({ payload, signature, secret }) =>
      pipe(
        fromPromise(
          async () => {
            // Stripe webhook signatures use HMAC SHA256
            // Format: t=<timestamp>,v1=<signature>
            const parts = signature.split(',').reduce<Record<string, string>>((acc, part) => {
              const [key, ...val] = part.split('=');
              acc[key] = val.join('=');
              return acc;
            }, {});

            const timestamp = parts['t'];
            const sig = parts['v1'];

            if (!timestamp || !sig) return false;

            const signedPayload = `${timestamp}.${payload}`;
            const { createHmac, timingSafeEqual } = await import('node:crypto');
            const expected = createHmac('sha256', secret)
              .update(signedPayload)
              .digest('hex');

            try {
              return timingSafeEqual(
                Buffer.from(sig, 'hex'),
                Buffer.from(expected, 'hex')
              );
            } catch {
              return false;
            }
          },
          (e) => Errors.payment('WEBHOOK_VERIFY_FAILED', String(e), 'stripe', false)
        )
      ),

    parseWebhook: (payload) =>
      pipe(
        TE.tryCatch(
          async () => {
            const event = JSON.parse(payload) as {
              type: string;
              data: {
                object: {
                  id: string;
                  amount: number;
                  currency: string;
                  created: number;
                  metadata?: Record<string, string>;
                  payment_intent?: string;
                };
              };
            };

            const typeMap: Record<string, PaymentWebhookEvent['type']> = {
              'payment_intent.succeeded': 'payment.completed',
              'payment_intent.payment_failed': 'payment.failed',
              'payment_intent.canceled': 'payment.cancelled',
              'charge.refunded': 'refund.completed',
              'charge.refund.updated': 'refund.completed',
            };

            const obj = event.data.object;

            return {
              type: typeMap[event.type] ?? 'payment.failed',
              transactionId: obj.id,
              intentId: obj.payment_intent,
              amount: obj.amount,
              currency: obj.currency.toUpperCase(),
              timestamp: new Date(obj.created * 1000).toISOString(),
              metadata: obj.metadata,
              raw: event,
            } satisfies PaymentWebhookEvent;
          },
          (e) => Errors.payment('WEBHOOK_PARSE_FAILED', String(e), 'stripe', false)
        )
      ),

    getClientConfig: () => ({
      name: 'stripe',
      displayName: 'Credit/Debit Card',
      icon: 'stripe',
      clientId: config.publishableKey,
      environment: config.secretKey.startsWith('sk_test_') ? 'sandbox' : 'production',
      supportedCurrencies: ['USD'],
    }),
  };
};

export type { StripeAdapterConfig };
