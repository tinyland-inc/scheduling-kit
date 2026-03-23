/**
 * Tests for core/types.ts
 * Type definitions and error constructors
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Errors } from '../core/types.js';
import type { SchedulingError } from '../core/types.js';

describe('Error Constructors', () => {
  describe('Errors.acuity', () => {
    it('creates AcuityError with all fields', () => {
      const error = Errors.acuity('NOT_FOUND', 'Appointment not found', 404, '/appointments/123');

      expect(error._tag).toBe('AcuityError');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('Appointment not found');
      expect(error.statusCode).toBe(404);
      expect(error.endpoint).toBe('/appointments/123');
    });

    it('handles optional fields', () => {
      const error = Errors.acuity('ERROR', 'Something went wrong');

      expect(error._tag).toBe('AcuityError');
      expect(error.code).toBe('ERROR');
      expect(error.message).toBe('Something went wrong');
      expect(error.statusCode).toBeUndefined();
      expect(error.endpoint).toBeUndefined();
    });
  });

  describe('Errors.calcom', () => {
    it('creates CalComError with all fields', () => {
      const error = Errors.calcom('VALIDATION', 'Invalid booking data', 400);

      expect(error._tag).toBe('CalComError');
      expect(error.code).toBe('VALIDATION');
      expect(error.message).toBe('Invalid booking data');
      expect(error.statusCode).toBe(400);
    });
  });

  describe('Errors.payment', () => {
    it('creates PaymentError', () => {
      const error = Errors.payment('DECLINED', 'Card declined', 'venmo', true, 'txn_123');

      expect(error._tag).toBe('PaymentError');
      expect(error.code).toBe('DECLINED');
      expect(error.message).toBe('Card declined');
      expect(error.processor).toBe('venmo');
      expect(error.recoverable).toBe(true);
      expect(error.transactionId).toBe('txn_123');
    });

    it('defaults recoverable to false', () => {
      const error = Errors.payment('NETWORK', 'Network error', 'stripe');
      expect(error.recoverable).toBe(false);
    });
  });

  describe('Errors.validation', () => {
    it('creates ValidationError', () => {
      const error = Errors.validation('email', 'Invalid email format', 'not-an-email');

      expect(error._tag).toBe('ValidationError');
      expect(error.field).toBe('email');
      expect(error.message).toBe('Invalid email format');
      expect(error.value).toBe('not-an-email');
    });

    it('handles optional value', () => {
      const error = Errors.validation('name', 'Name is required');
      expect(error.value).toBeUndefined();
    });
  });

  describe('Errors.reservation', () => {
    it('creates ReservationError for SLOT_TAKEN', () => {
      const error = Errors.reservation('SLOT_TAKEN', 'Slot no longer available', '2024-01-01T10:00:00Z');

      expect(error._tag).toBe('ReservationError');
      expect(error.code).toBe('SLOT_TAKEN');
      expect(error.message).toBe('Slot no longer available');
      expect(error.datetime).toBe('2024-01-01T10:00:00Z');
    });

    it('handles different codes', () => {
      const codes = ['SLOT_TAKEN', 'BLOCK_FAILED', 'TIMEOUT'] as const;

      for (const code of codes) {
        const error = Errors.reservation(code, `Error: ${code}`);
        expect(error.code).toBe(code);
      }
    });
  });

  describe('Errors.idempotency', () => {
    it('creates IdempotencyError with existing result', () => {
      const existing = { bookingId: 'bk_123' };
      const error = Errors.idempotency('idem_key_1', existing);

      expect(error._tag).toBe('IdempotencyError');
      expect(error.key).toBe('idem_key_1');
      expect(error.existingResult).toEqual(existing);
    });

    it('handles undefined existingResult', () => {
      const error = Errors.idempotency('idem_key_2');
      expect(error.existingResult).toBeUndefined();
    });
  });

  describe('Errors.infrastructure', () => {
    it('creates InfrastructureError', () => {
      const error = Errors.infrastructure('REDIS', 'Connection refused');

      expect(error._tag).toBe('InfrastructureError');
      expect(error.code).toBe('REDIS');
      expect(error.message).toBe('Connection refused');
    });

    it('handles optional cause', () => {
      const cause = new Error('Original error');
      const error = Errors.infrastructure('NETWORK', 'Request failed', cause);

      expect(error.cause).toBe(cause);
    });

    it('validates infrastructure codes', () => {
      const codes = ['NETWORK', 'TIMEOUT', 'REDIS', 'UNKNOWN'] as const;

      for (const code of codes) {
        const error = Errors.infrastructure(code, 'Test error');
        expect(error.code).toBe(code);
      }
    });
  });
});

describe('Error Type Guards', () => {
  const isAcuityError = (e: SchedulingError): e is ReturnType<typeof Errors.acuity> =>
    e._tag === 'AcuityError';

  const isPaymentError = (e: SchedulingError): e is ReturnType<typeof Errors.payment> =>
    e._tag === 'PaymentError';

  const isValidationError = (e: SchedulingError): e is ReturnType<typeof Errors.validation> =>
    e._tag === 'ValidationError';

  it('type guards work correctly', () => {
    const acuityError = Errors.acuity('NOT_FOUND', 'Not found');
    const paymentError = Errors.payment('DECLINED', 'Declined', 'venmo');
    const validationError = Errors.validation('email', 'Invalid');

    expect(isAcuityError(acuityError)).toBe(true);
    expect(isAcuityError(paymentError)).toBe(false);

    expect(isPaymentError(paymentError)).toBe(true);
    expect(isPaymentError(acuityError)).toBe(false);

    expect(isValidationError(validationError)).toBe(true);
    expect(isValidationError(paymentError)).toBe(false);
  });
});

describe('Error Discriminated Union', () => {
  it('exhaustive pattern matching', () => {
    const handleError = (error: SchedulingError): string => {
      switch (error._tag) {
        case 'AcuityError':
          return `Acuity: ${error.code}`;
        case 'CalComError':
          return `CalCom: ${error.code}`;
        case 'PaymentError':
          return `Payment: ${error.code}`;
        case 'ValidationError':
          return `Validation: ${error.field}`;
        case 'ReservationError':
          return `Reservation: ${error.code}`;
        case 'IdempotencyError':
          return `Idempotency: ${error.key}`;
        case 'InfrastructureError':
          return `Infrastructure: ${error.code}`;
      }
    };

    expect(handleError(Errors.acuity('NOT_FOUND', 'Missing'))).toBe('Acuity: NOT_FOUND');
    expect(handleError(Errors.payment('DECLINED', 'No', 'venmo'))).toBe('Payment: DECLINED');
    expect(handleError(Errors.validation('email', 'Bad'))).toBe('Validation: email');
  });
});

describe('Property-based Error Tests', () => {
  describe('Errors.acuity', () => {
    it('preserves code and message', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          (code, message) => {
            const error = Errors.acuity(code, message);
            expect(error.code).toBe(code);
            expect(error.message).toBe(message);
            expect(error._tag).toBe('AcuityError');
          }
        )
      );
    });
  });

  describe('Errors.validation', () => {
    it('preserves field and message', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          (field, message) => {
            const error = Errors.validation(field, message);
            expect(error.field).toBe(field);
            expect(error.message).toBe(message);
          }
        )
      );
    });
  });

  describe('Errors.infrastructure', () => {
    it('always produces InfrastructureError tag', () => {
      const validCodes = ['NETWORK', 'TIMEOUT', 'REDIS', 'UNKNOWN'] as const;

      fc.assert(
        fc.property(
          fc.constantFrom(...validCodes),
          fc.string({ minLength: 1, maxLength: 200 }),
          (code, message) => {
            const error = Errors.infrastructure(code, message);
            expect(error._tag).toBe('InfrastructureError');
          }
        )
      );
    });
  });

  describe('All error types', () => {
    const errorArbitrary = fc.oneof(
      fc.tuple(fc.string(), fc.string()).map(([code, msg]) => Errors.acuity(code, msg)),
      fc.tuple(fc.string(), fc.string()).map(([code, msg]) => Errors.payment(code, msg, 'test')),
      fc.tuple(fc.string(), fc.string()).map(([field, msg]) => Errors.validation(field, msg)),
      fc.tuple(
        fc.constantFrom('NETWORK', 'TIMEOUT', 'REDIS', 'UNKNOWN' as const),
        fc.string()
      ).map(([code, msg]) => Errors.infrastructure(code as any, msg))
    );

    it('all errors have _tag property', () => {
      fc.assert(
        fc.property(errorArbitrary, (error) => {
          expect(error).toHaveProperty('_tag');
          expect(typeof error._tag).toBe('string');
        })
      );
    });

    it('all errors have message property', () => {
      fc.assert(
        fc.property(errorArbitrary, (error) => {
          expect(error).toHaveProperty('message');
        })
      );
    });
  });
});

describe('Error Message Quality', () => {
  it('acuity errors include status code when provided', () => {
    const error = Errors.acuity('NOT_FOUND', 'Resource not found', 404);
    expect(error.statusCode).toBe(404);
  });

  it('payment errors include processor', () => {
    const error = Errors.payment('DECLINED', 'Payment failed', 'venmo');
    expect(error.processor).toBe('venmo');
  });

  it('validation errors include field name', () => {
    const error = Errors.validation('email', 'Invalid format');
    expect(error.field).toBe('email');
  });

  it('reservation errors include datetime when provided', () => {
    const datetime = '2024-06-15T14:00:00Z';
    const error = Errors.reservation('SLOT_TAKEN', 'Slot conflict', datetime);
    expect(error.datetime).toBe(datetime);
  });
});
