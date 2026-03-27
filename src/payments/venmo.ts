/**
 * Venmo Payment Adapter
 * Uses PayPal SDK with enable-funding=venmo for Venmo payments
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
  VenmoAdapterConfig,
} from './types.js';

// =============================================================================
// PAYPAL API TYPES
// =============================================================================

interface PayPalOrder {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  purchase_units: {
    reference_id: string;
    amount: {
      currency_code: string;
      value: string;
    };
    payments?: {
      captures?: {
        id: string;
        status: string;
        amount: {
          currency_code: string;
          value: string;
        };
      }[];
    };
  }[];
  create_time: string;
  links: { rel: string; href: string }[];
}

interface PayPalRefund {
  id: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  amount: {
    currency_code: string;
    value: string;
  };
  create_time: string;
}

// =============================================================================
// VENMO ADAPTER IMPLEMENTATION
// =============================================================================

export const createVenmoAdapter = (config: VenmoAdapterConfig): PaymentAdapter => {
  const baseUrl = config.environment === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  let accessToken: string | null = null;
  let tokenExpiry: number = 0;

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  const getAccessToken = async (): Promise<string> => {
    if (accessToken && Date.now() < tokenExpiry) {
      return accessToken;
    }

    const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`PayPal auth failed: ${response.status}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Refresh 1 min early

    return accessToken;
  };

  // ---------------------------------------------------------------------------
  // HTTP Client
  // ---------------------------------------------------------------------------

  const request = async <T>(
    method: string,
    endpoint: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T> => {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    if (idempotencyKey) {
      headers['PayPal-Request-Id'] = idempotencyKey;
    }

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`PayPal API error ${response.status}: ${errorBody}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  };

  // ---------------------------------------------------------------------------
  // Transformers
  // ---------------------------------------------------------------------------

  const toPaymentIntent = (order: PayPalOrder, requestAmount?: number, requestCurrency?: string): PaymentIntent => ({
    id: order.id,
    amount: order.purchase_units?.[0]?.amount?.value
      ? Math.round(parseFloat(order.purchase_units[0].amount.value) * 100)
      : requestAmount ?? 0,
    currency: order.purchase_units?.[0]?.amount?.currency_code ?? requestCurrency ?? 'USD',
    status: order.status === 'COMPLETED' ? 'completed'
      : order.status === 'APPROVED' ? 'processing'
      : order.status === 'VOIDED' ? 'cancelled'
      : 'pending',
    processor: 'venmo',
    processorTransactionId: order.id,
    createdAt: order.create_time ?? new Date().toISOString(),
  });

  const toPaymentResult = (order: PayPalOrder): PaymentResult => {
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    const unitAmount = order.purchase_units?.[0]?.amount;
    return {
      success: order.status === 'COMPLETED',
      transactionId: capture?.id ?? order.id,
      processor: 'venmo',
      amount: Math.round(parseFloat(capture?.amount?.value ?? unitAmount?.value ?? '0') * 100),
      currency: capture?.amount?.currency_code ?? unitAmount?.currency_code ?? 'USD',
      timestamp: new Date().toISOString(),
    };
  };

  // ---------------------------------------------------------------------------
  // Interface Implementation
  // ---------------------------------------------------------------------------

  return {
    name: 'venmo',
    displayName: 'Venmo',
    icon: 'venmo',

    isAvailable: () => Effect.succeed(true),

    createIntent: ({ amount, currency, description, metadata, idempotencyKey }) =>
      pipe(
        fromPromise(
          () => request<PayPalOrder>(
            'POST',
            '/v2/checkout/orders',
            {
              intent: 'CAPTURE',
              purchase_units: [{
                reference_id: idempotencyKey,
                description,
                amount: {
                  currency_code: currency,
                  value: (amount / 100).toFixed(2),
                },
                custom_id: metadata ? JSON.stringify(metadata) : undefined,
              }],
              payment_source: {
                venmo: {
                  experience_context: {
                    payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
                    brand_name: config.brandName ?? 'Business',
                    shipping_preference: 'NO_SHIPPING',
                    user_action: 'PAY_NOW',
                  },
                },
              },
            },
            idempotencyKey
          ),
          (e) => Errors.payment('CREATE_INTENT_FAILED', String(e), 'venmo', true)
        ),
        Effect.map((order) => toPaymentIntent(order, amount, currency))
      ),

    capturePayment: (intentId) =>
      pipe(
        fromPromise(
          () => request<PayPalOrder>('POST', `/v2/checkout/orders/${intentId}/capture`),
          (e) => Errors.payment('CAPTURE_FAILED', String(e), 'venmo', false, intentId)
        ),
        Effect.map(toPaymentResult)
      ),

    cancelIntent: (intentId) =>
      pipe(
        fromPromise(
          // PayPal orders can't be explicitly cancelled, they expire
          // But we can void if authorized
          async () => {
            // For now, just return success - orders expire automatically
            console.log(`Venmo intent ${intentId} cancellation requested`);
          },
          (e) => Errors.payment('CANCEL_FAILED', String(e), 'venmo', false, intentId)
        )
      ),

    refund: ({ transactionId, amount, reason }) =>
      pipe(
        fromPromise(
          async () => {
            const body: { amount?: { currency_code: string; value: string }; note_to_payer?: string } = {};

            if (amount) {
              body.amount = {
                currency_code: 'USD',
                value: (amount / 100).toFixed(2),
              };
            }

            if (reason) {
              body.note_to_payer = reason;
            }

            return request<PayPalRefund>(
              'POST',
              `/v2/payments/captures/${transactionId}/refund`,
              Object.keys(body).length > 0 ? body : undefined
            );
          },
          (e) => Errors.payment('REFUND_FAILED', String(e), 'venmo', false, transactionId)
        ),
        Effect.map((refund) => ({
          success: refund.status === 'COMPLETED',
          refundId: refund.id,
          originalTransactionId: transactionId,
          amount: Math.round(parseFloat(refund.amount.value) * 100),
          currency: refund.amount.currency_code,
          timestamp: refund.create_time,
        }))
      ),

    verifyWebhook: ({ payload, signature, transmissionId, transmissionTime, certUrl }) =>
      pipe(
        fromPromise(
          async () => {
            // PayPal webhook verification via their verification endpoint
            const response = await request<{ verification_status: string }>(
              'POST',
              '/v1/notifications/verify-webhook-signature',
              {
                auth_algo: 'SHA256withRSA',
                cert_url: certUrl ?? '',
                transmission_id: transmissionId ?? '',
                transmission_sig: signature,
                transmission_time: transmissionTime ?? '',
                webhook_id: config.webhookId,
                webhook_event: JSON.parse(payload),
              }
            );

            return response.verification_status === 'SUCCESS';
          },
          (e) => Errors.payment('WEBHOOK_VERIFY_FAILED', String(e), 'venmo', false)
        )
      ),

    parseWebhook: (payload) =>
      Effect.tryPromise({
        try: async () => {
          const event = JSON.parse(payload) as {
            event_type: string;
            resource: {
              id: string;
              amount: { value: string; currency_code: string };
              create_time: string;
              custom_id?: string;
            };
          };

          const typeMap: Record<string, PaymentWebhookEvent['type']> = {
            'PAYMENT.CAPTURE.COMPLETED': 'payment.completed',
            'PAYMENT.CAPTURE.DENIED': 'payment.failed',
            'PAYMENT.CAPTURE.REFUNDED': 'refund.completed',
          };

          return {
            type: typeMap[event.event_type] ?? 'payment.failed',
            transactionId: event.resource.id,
            amount: Math.round(parseFloat(event.resource.amount.value) * 100),
            currency: event.resource.amount.currency_code,
            timestamp: event.resource.create_time,
            metadata: event.resource.custom_id
              ? JSON.parse(event.resource.custom_id)
              : undefined,
            raw: event,
          } satisfies PaymentWebhookEvent;
        },
        catch: (e) => Errors.payment('WEBHOOK_PARSE_FAILED', String(e), 'venmo', false),
      }),

    getClientConfig: () => ({
      name: 'venmo',
      displayName: 'Venmo',
      icon: 'venmo',
      clientId: config.clientId,
      environment: config.environment,
      supportedCurrencies: ['USD'],
      minAmount: 100, // $1.00
      maxAmount: 299999, // $2,999.99 (Venmo limit)
    }),
  };
};

export type { VenmoAdapterConfig };
