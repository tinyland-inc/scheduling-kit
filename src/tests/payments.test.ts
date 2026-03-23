/**
 * Tests for payment adapters
 * Manual payment methods (cash, zelle, check)
 */
import { describe, it, expect } from 'vitest';
import * as E from 'fp-ts/Either';
import * as fc from 'fast-check';
import {
  createManualPaymentAdapter,
  createCashAdapter,
  createZelleAdapter,
  createCheckAdapter,
} from '../payments/manual.js';
import type { PaymentAdapter } from '../payments/types.js';

describe('Manual Payment Adapters', () => {
  describe('createManualPaymentAdapter', () => {
    it('creates adapter with custom config', () => {
      const adapter = createManualPaymentAdapter(
        {
          type: 'manual',
          methods: ['custom' as any],
          instructions: { custom: 'Custom instructions' },
        },
        'custom',
        'Custom Payment'
      );

      expect(adapter.name).toBe('custom');
      expect(adapter.displayName).toBe('Custom Payment');
    });

    describe('createIntent', () => {
      it('creates payment intent with correct structure', async () => {
        const adapter = createManualPaymentAdapter(
          { type: 'manual', methods: ['test' as any] },
          'test',
          'Test'
        );

        const result = await adapter.createIntent({
          amount: 5000,
          currency: 'USD',
          description: 'Test payment',
          idempotencyKey: 'idem_123',
        })();

        expect(E.isRight(result)).toBe(true);
        if (E.isRight(result)) {
          const intent = result.right;
          expect(intent.id).toMatch(/^manual_/);
          expect(intent.amount).toBe(5000);
          expect(intent.currency).toBe('USD');
          expect(intent.status).toBe('pending');
          expect(intent.processor).toBe('test');
        }
      });

      it('generates unique intent IDs', async () => {
        const adapter = createManualPaymentAdapter(
          { type: 'manual', methods: ['test' as any] },
          'test',
          'Test'
        );

        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
          const result = await adapter.createIntent({
            amount: 1000,
            currency: 'USD',
            description: 'test payment',
            idempotencyKey: `idem_${i}`,
          })();

          if (E.isRight(result)) {
            ids.add(result.right.id);
          }
        }

        expect(ids.size).toBe(100);
      });
    });

    describe('capturePayment', () => {
      it('returns captured payment result', async () => {
        const adapter = createManualPaymentAdapter(
          { type: 'manual', methods: ['test' as any] },
          'test',
          'Test'
        );

        const result = await adapter.capturePayment('manual_123')();

        expect(E.isRight(result)).toBe(true);
        if (E.isRight(result)) {
          const payment = result.right;
          expect(payment.success).toBe(true);
          expect(payment.transactionId).toBe('manual_123_pending');
          expect(payment.processor).toBe('test');
        }
      });
    });

    describe('refund', () => {
      it('creates refund record', async () => {
        const adapter = createManualPaymentAdapter(
          { type: 'manual', methods: ['test' as any] },
          'test',
          'Test'
        );

        const result = await adapter.refund({
          transactionId: 'txn_123',
          amount: 2500,
          reason: 'Customer request',
        })();

        expect(E.isRight(result)).toBe(true);
        if (E.isRight(result)) {
          const refund = result.right;
          expect(refund.refundId).toMatch(/^refund_/);
          expect(refund.originalTransactionId).toBe('txn_123');
          expect(refund.success).toBe(true);
        }
      });
    });

    describe('isAvailable', () => {
      it('returns true when methods are configured', async () => {
        const adapter = createManualPaymentAdapter(
          { type: 'manual', methods: ['cash'] },
          'cash',
          'Cash'
        );

        const result = await adapter.isAvailable()();
        expect(E.isRight(result)).toBe(true);
        if (E.isRight(result)) {
          expect(result.right).toBe(true);
        }
      });

      it('returns false when no methods configured', async () => {
        const adapter = createManualPaymentAdapter(
          { type: 'manual', methods: [] },
          'empty',
          'Empty'
        );

        const result = await adapter.isAvailable()();
        expect(E.isRight(result)).toBe(true);
        if (E.isRight(result)) {
          expect(result.right).toBe(false);
        }
      });
    });
  });

  describe('createCashAdapter', () => {
    it('creates cash payment adapter', () => {
      const adapter = createCashAdapter();

      expect(adapter.name).toBe('cash');
      expect(adapter.displayName).toBe('Pay with Cash');
    });

    it('provides instructions for cash payment', () => {
      const adapter = createCashAdapter();
      const config = adapter.getClientConfig();

      expect((config as any).instructions).toBeDefined();
      expect((config as any).instructions?.cash).toContain('appointment');
    });
  });

  describe('createZelleAdapter', () => {
    const zelleEmail = 'massage@example.com';

    it('creates zelle payment adapter with recipient', () => {
      const adapter = createZelleAdapter(zelleEmail);

      expect(adapter.name).toBe('zelle');
      expect(adapter.displayName).toBe('Pay with Zelle');
    });

    it('includes recipient in instructions', () => {
      const adapter = createZelleAdapter(zelleEmail);
      const config = adapter.getClientConfig();

      expect((config as any).instructions?.zelle).toContain(zelleEmail);
    });
  });

  describe('createCheckAdapter', () => {
    it('creates check payment adapter', () => {
      const adapter = createCheckAdapter('Test Business');

      expect(adapter.name).toBe('check');
      expect(adapter.displayName).toBe('Pay by Check');
    });

    it('includes payee in instructions', () => {
      const adapter = createCheckAdapter('Test Business');
      const config = adapter.getClientConfig();

      expect((config as any).instructions?.check).toContain('Test Business');
    });
  });
});

describe('Payment Adapter Interface Compliance', () => {
  const adapters: Array<{ name: string; adapter: PaymentAdapter }> = [
    { name: 'cash', adapter: createCashAdapter() },
    { name: 'zelle', adapter: createZelleAdapter('test@example.com') },
    { name: 'check', adapter: createCheckAdapter('Test Business') },
    {
      name: 'custom',
      adapter: createManualPaymentAdapter(
        { type: 'manual', methods: ['custom' as any] },
        'custom',
        'Custom'
      ),
    },
  ];

  for (const { name, adapter } of adapters) {
    describe(`${name} adapter`, () => {
      it('has name property', () => {
        expect(adapter.name).toBeDefined();
        expect(typeof adapter.name).toBe('string');
      });

      it('has displayName property', () => {
        expect(adapter.displayName).toBeDefined();
        expect(typeof adapter.displayName).toBe('string');
      });

      it('has getClientConfig method', () => {
        expect(typeof adapter.getClientConfig).toBe('function');
        const config = adapter.getClientConfig();
        expect(config).toHaveProperty('name');
        expect(config).toHaveProperty('displayName');
      });

      it('has createIntent method', () => {
        expect(typeof adapter.createIntent).toBe('function');
      });

      it('has capturePayment method', () => {
        expect(typeof adapter.capturePayment).toBe('function');
      });

      it('has refund method', () => {
        expect(typeof adapter.refund).toBe('function');
      });

      it('has isAvailable method', () => {
        expect(typeof adapter.isAvailable).toBe('function');
      });
    });
  }
});

describe('Property-based Payment Tests', () => {
  const adapter = createManualPaymentAdapter(
    { type: 'manual', methods: ['test' as any] },
    'test',
    'Test'
  );

  describe('createIntent', () => {
    it('amount is preserved in intent', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1000000 }),
          async (amount) => {
            const result = await adapter.createIntent({
              amount,
              currency: 'USD',
              description: 'test payment',
              idempotencyKey: `idem_${amount}_${Date.now()}`,
            })();

            expect(E.isRight(result)).toBe(true);
            if (E.isRight(result)) {
              expect(result.right.amount).toBe(amount);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('currency is preserved in intent', async () => {
      const currencies = ['USD', 'EUR', 'GBP', 'CAD'] as const;

      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...currencies),
          async (currency) => {
            const result = await adapter.createIntent({
              amount: 1000,
              currency,
              description: 'test payment',
              idempotencyKey: `idem_${currency}_${Date.now()}`,
            })();

            expect(E.isRight(result)).toBe(true);
            if (E.isRight(result)) {
              expect(result.right.currency).toBe(currency);
            }
          }
        )
      );
    });
  });
});

describe('Payment Flow Integration', () => {
  it('complete payment flow: intent → capture', async () => {
    const adapter = createCashAdapter();

    // Create intent
    const intentResult = await adapter.createIntent({
      amount: 7500,
      currency: 'USD',
      description: '60min massage',
      idempotencyKey: 'idem_flow_test',
    })();

    expect(E.isRight(intentResult)).toBe(true);
    if (!E.isRight(intentResult)) return;

    const intent = intentResult.right;
    expect(intent.status).toBe('pending');

    // Capture payment
    const captureResult = await adapter.capturePayment(intent.id)();

    expect(E.isRight(captureResult)).toBe(true);
    if (!E.isRight(captureResult)) return;

    const payment = captureResult.right;
    expect(payment.success).toBe(true);
  });

  it('refund flow after capture', async () => {
    const adapter = createZelleAdapter('test@example.com');

    // Create and capture
    const intentResult = await adapter.createIntent({
      amount: 10000,
      currency: 'USD',
      description: 'test payment',
      idempotencyKey: 'idem_refund_test',
    })();

    if (!E.isRight(intentResult)) return;
    const intent = intentResult.right;

    const captureResult = await adapter.capturePayment(intent.id)();
    if (!E.isRight(captureResult)) return;

    // Refund
    const refundResult = await adapter.refund({
      transactionId: captureResult.right.transactionId,
      amount: 5000,
      reason: 'Partial refund',
    })();

    expect(E.isRight(refundResult)).toBe(true);
    if (!E.isRight(refundResult)) return;

    const refund = refundResult.right;
    expect(refund.success).toBe(true);
  });
});

describe('Client Config', () => {
  it('cash adapter has correct config', () => {
    const adapter = createCashAdapter();
    const config = adapter.getClientConfig();

    expect(config.name).toBe('cash');
    expect(config.environment).toBe('production');
    expect(config.supportedCurrencies).toContain('USD');
  });

  it('zelle adapter has correct config', () => {
    const adapter = createZelleAdapter('test@example.com');
    const config = adapter.getClientConfig();

    expect(config.name).toBe('zelle');
    expect((config as any).instructions?.zelle).toContain('test@example.com');
  });
});
