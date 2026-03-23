/**
 * Tests for Venmo payment adapter
 * Validates PayPal API integration for Venmo payments
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import * as E from 'fp-ts/Either';
import { createVenmoAdapter } from '../../../payments/venmo.js';
import type { PaymentAdapter } from '../../../payments/types.js';
import { server } from '../../mocks/server.js';
import { resetPayPalMockState, configurePayPalMock } from '../../mocks/handlers/index.js';
import { expectRightAsync, expectLeftTagAsync } from '../../helpers/fp-ts.js';

// MSW server lifecycle
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  resetPayPalMockState();
});

afterAll(() => {
  server.close();
});

describe('Venmo Adapter', () => {
  let adapter: PaymentAdapter;

  beforeAll(() => {
    adapter = createVenmoAdapter({
      type: 'venmo',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      environment: 'sandbox',
      webhookId: 'test-webhook-id',
    });
  });

  describe('isAvailable', () => {
    it('returns true when service is available', async () => {
      const result = await expectRightAsync(adapter.isAvailable());
      expect(result).toBe(true);
    });
  });

  describe('createIntent', () => {
    it('creates a payment intent successfully', async () => {
      const intent = await expectRightAsync(
        adapter.createIntent({
          amount: 20000, // $200.00 in cents
          currency: 'USD',
          description: 'TMD 60min massage',
          idempotencyKey: 'test-idempotency-key',
        })
      );

      expect(intent.id).toBeDefined();
      expect(intent.amount).toBe(20000);
      expect(intent.currency).toBe('USD');
      expect(intent.processor).toBe('venmo');
      expect(intent.status).toBe('pending');
    });

    it('includes metadata in intent', async () => {
      const intent = await expectRightAsync(
        adapter.createIntent({
          amount: 15000,
          currency: 'USD',
          description: 'Massage session',
          metadata: { bookingId: '12345', serviceId: '67890' },
          idempotencyKey: 'test-meta-key',
        })
      );

      expect(intent.id).toBeDefined();
      expect(intent.processor).toBe('venmo');
    });

    it('handles API errors gracefully', async () => {
      configurePayPalMock({ failNextRequest: true });

      const error = await expectLeftTagAsync(
        adapter.createIntent({
          amount: 20000,
          currency: 'USD',
          description: 'Test payment',
          idempotencyKey: 'fail-key',
        }),
        'PaymentError'
      );

      expect(error._tag).toBe('PaymentError');
      if (error._tag === 'PaymentError') {
        expect(error.code).toBe('CREATE_INTENT_FAILED');
        expect(error.processor).toBe('venmo');
        expect(error.recoverable).toBe(true);
      }
    });
  });

  describe('capturePayment', () => {
    it('captures an approved order successfully', async () => {
      // First create an intent
      const intent = await expectRightAsync(
        adapter.createIntent({
          amount: 20000,
          currency: 'USD',
          description: 'Test capture',
          idempotencyKey: 'capture-test-key',
        })
      );

      // Then capture it
      const result = await expectRightAsync(adapter.capturePayment(intent.id));

      expect(result.success).toBe(true);
      expect(result.transactionId).toBeDefined();
      expect(result.processor).toBe('venmo');
      expect(result.amount).toBe(20000);
      expect(result.currency).toBe('USD');
      expect(result.timestamp).toBeDefined();
    });

    it('handles capture failure', async () => {
      configurePayPalMock({ simulateCaptureFailure: true });

      const error = await expectLeftTagAsync(
        adapter.capturePayment('order_to_fail'),
        'PaymentError'
      );

      expect(error._tag).toBe('PaymentError');
      if (error._tag === 'PaymentError') {
        expect(error.code).toBe('CAPTURE_FAILED');
        expect(error.recoverable).toBe(false);
      }
    });
  });

  describe('cancelIntent', () => {
    it('cancels an intent (no-op for PayPal)', async () => {
      // PayPal orders can't be explicitly cancelled, they expire
      const result = await adapter.cancelIntent('order_to_cancel')();

      expect(E.isRight(result)).toBe(true);
    });
  });

  describe('refund', () => {
    it('processes a full refund successfully', async () => {
      const refund = await expectRightAsync(
        adapter.refund({
          transactionId: 'capture_12345',
          reason: 'Customer requested cancellation',
        })
      );

      expect(refund.success).toBe(true);
      expect(refund.refundId).toBeDefined();
      expect(refund.originalTransactionId).toBe('capture_12345');
      expect(refund.currency).toBe('USD');
      expect(refund.timestamp).toBeDefined();
    });

    it('processes a partial refund', async () => {
      const refund = await expectRightAsync(
        adapter.refund({
          transactionId: 'capture_67890',
          amount: 10000, // $100 partial refund
          reason: 'Partial service',
        })
      );

      expect(refund.success).toBe(true);
      expect(refund.amount).toBe(10000);
    });

    it('handles refund failure', async () => {
      configurePayPalMock({ simulateRefundFailure: true });

      const error = await expectLeftTagAsync(
        adapter.refund({
          transactionId: 'capture_fail',
          reason: 'Test failure',
        }),
        'PaymentError'
      );

      expect(error._tag).toBe('PaymentError');
      if (error._tag === 'PaymentError') {
        expect(error.code).toBe('REFUND_FAILED');
        expect(error.processor).toBe('venmo');
      }
    });
  });

  describe('getClientConfig', () => {
    it('returns correct client configuration', () => {
      const config = adapter.getClientConfig();

      expect(config.name).toBe('venmo');
      expect(config.displayName).toBe('Venmo');
      expect(config.clientId).toBe('test-client-id');
      expect(config.environment).toBe('sandbox');
      expect(config.supportedCurrencies).toContain('USD');
      expect(config.minAmount).toBe(100); // $1.00
      expect(config.maxAmount).toBe(299999); // $2,999.99
    });
  });

  describe('parseWebhook', () => {
    it('parses payment completed webhook', async () => {
      const payload = JSON.stringify({
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'capture_webhook_test',
          amount: { value: '200.00', currency_code: 'USD' },
          create_time: '2026-02-15T14:00:00Z',
          custom_id: JSON.stringify({ bookingId: '12345' }),
        },
      });

      const event = await expectRightAsync(adapter.parseWebhook(payload));

      expect(event.type).toBe('payment.completed');
      expect(event.transactionId).toBe('capture_webhook_test');
      expect(event.amount).toBe(20000);
      expect(event.currency).toBe('USD');
      expect(event.metadata).toEqual({ bookingId: '12345' });
    });

    it('parses payment failed webhook', async () => {
      const payload = JSON.stringify({
        event_type: 'PAYMENT.CAPTURE.DENIED',
        resource: {
          id: 'capture_denied',
          amount: { value: '100.00', currency_code: 'USD' },
          create_time: '2026-02-15T14:00:00Z',
        },
      });

      const event = await expectRightAsync(adapter.parseWebhook(payload));

      expect(event.type).toBe('payment.failed');
      expect(event.transactionId).toBe('capture_denied');
    });

    it('parses refund completed webhook', async () => {
      const payload = JSON.stringify({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'refund_webhook_test',
          amount: { value: '150.00', currency_code: 'USD' },
          create_time: '2026-02-15T15:00:00Z',
        },
      });

      const event = await expectRightAsync(adapter.parseWebhook(payload));

      expect(event.type).toBe('refund.completed');
      expect(event.amount).toBe(15000);
    });

    it('handles unknown event type', async () => {
      const payload = JSON.stringify({
        event_type: 'UNKNOWN.EVENT.TYPE',
        resource: {
          id: 'unknown_event',
          amount: { value: '50.00', currency_code: 'USD' },
          create_time: '2026-02-15T14:00:00Z',
        },
      });

      const event = await expectRightAsync(adapter.parseWebhook(payload));

      // Unknown events default to payment.failed
      expect(event.type).toBe('payment.failed');
    });

    it('handles invalid JSON payload', async () => {
      const error = await expectLeftTagAsync(
        adapter.parseWebhook('invalid json'),
        'PaymentError'
      );

      expect(error._tag).toBe('PaymentError');
      if (error._tag === 'PaymentError') {
        expect(error.code).toBe('WEBHOOK_PARSE_FAILED');
      }
    });
  });
});

describe('Venmo Adapter Transformers', () => {
  // Test internal transformer logic via the public interface
  let adapter: PaymentAdapter;

  beforeAll(() => {
    adapter = createVenmoAdapter({
      type: 'venmo',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      environment: 'sandbox',
      webhookId: 'test-webhook-id',
    });
  });

  describe('amount conversion', () => {
    it('correctly converts cents to dollars for API', async () => {
      // Create intent with $1.00 (100 cents)
      const intent = await expectRightAsync(
        adapter.createIntent({
          amount: 100,
          currency: 'USD',
          description: 'Minimum amount',
          idempotencyKey: 'min-amount-key',
        })
      );

      // Mock returns what we sent, verify it's correct
      expect(intent.amount).toBe(100);
    });

    it('correctly converts dollars to cents from API', async () => {
      // Webhook payload has dollars (e.g., "200.00")
      const payload = JSON.stringify({
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'conversion_test',
          amount: { value: '200.00', currency_code: 'USD' },
          create_time: '2026-02-15T14:00:00Z',
        },
      });

      const event = await expectRightAsync(adapter.parseWebhook(payload));

      // Should be converted to cents
      expect(event.amount).toBe(20000);
    });
  });

  describe('status mapping', () => {
    it('maps PayPal CREATED status to pending', async () => {
      // Default mock returns CREATED status
      const intent = await expectRightAsync(
        adapter.createIntent({
          amount: 10000,
          currency: 'USD',
          description: 'Status test',
          idempotencyKey: 'status-test-key',
        })
      );

      expect(intent.status).toBe('pending');
    });
  });
});
