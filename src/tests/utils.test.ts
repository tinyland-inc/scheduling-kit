/**
 * Tests for core/utils.ts
 * fp-ts utility functions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as TE from 'fp-ts/TaskEither';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';

import {
  fromPromise,
  fromPromiseK,
  validateWith,
  validateFields,
  withRetry,
  withTimeout,
  fromOption,
  fromNullable,
  sequenceResults,
  parallelResults,
  recoverWith,
  mapError,
  generateId,
  generateIdempotencyKey,
  withIdempotency,
} from '../core/utils.js';
import { Errors } from '../core/types.js';

describe('Promise Converters', () => {
  describe('fromPromise', () => {
    it('converts successful promise to Right', async () => {
      const result = await fromPromise(
        () => Promise.resolve(42),
        () => Errors.infrastructure('TEST' as any, 'Should not fail')
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBe(42);
      }
    });

    it('converts rejected promise to Left with mapped error', async () => {
      const result = await fromPromise(
        () => Promise.reject(new Error('boom')),
        (e) => Errors.infrastructure('TEST' as any, String(e))
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('InfrastructureError');
        expect((result.left as any).message).toContain('boom');
      }
    });

    it('preserves async behavior', async () => {
      let called = false;
      const result = fromPromise(
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          called = true;
          return 'done';
        },
        () => Errors.infrastructure('TEST' as any, 'fail')
      );

      expect(called).toBe(false); // lazy
      await result();
      expect(called).toBe(true);
    });
  });

  describe('fromPromiseK', () => {
    it('creates a function that returns TaskEither', async () => {
      const fetchUser = fromPromiseK(
        async (id: string) => ({ id, name: 'Test' }),
        () => Errors.infrastructure('HTTP' as any, 'Failed')
      );

      const result = await fetchUser('123')();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual({ id: '123', name: 'Test' });
      }
    });
  });
});

describe('Validation', () => {
  describe('validateWith', () => {
    const TestSchema = z.object({
      name: z.string().min(1),
      age: z.number().positive(),
    });

    it('returns Right for valid data', async () => {
      const result = await validateWith(TestSchema, { name: 'John', age: 30 })();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual({ name: 'John', age: 30 });
      }
    });

    it('returns Left with ValidationError for invalid data', async () => {
      const result = await validateWith(TestSchema, { name: '', age: -5 })();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('ValidationError');
      }
    });

    it('transforms data through schema', async () => {
      const schema = z.string().transform((s) => s.toUpperCase());
      const result = await validateWith(schema, 'hello')();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBe('HELLO');
      }
    });
  });

  describe('validateFields', () => {
    it('validates multiple fields', async () => {
      const result = await validateFields(
        {
          email: z.string().email(),
          age: z.number().min(18),
        },
        { email: 'test@example.com', age: 25 }
      )();

      expect(E.isRight(result)).toBe(true);
    });

    it('collects multiple errors', async () => {
      const result = await validateFields(
        {
          email: z.string().email(),
          age: z.number().min(18),
        },
        { email: 'invalid', age: 10 }
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('ValidationError');
        expect((result.left as any).message).toContain('email');
        expect((result.left as any).message).toContain('age');
      }
    });
  });
});

describe('Retry & Resilience', () => {
  describe('withRetry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns success on first try if successful', async () => {
      const task = TE.right(42);
      const retried = withRetry({ maxAttempts: 3 })(task);

      const result = await retried();
      expect(E.isRight(result)).toBe(true);
    });

    it('retries on infrastructure error', async () => {
      let attempts = 0;
      const task: TE.TaskEither<ReturnType<typeof Errors.infrastructure>, number> = () => {
        attempts++;
        if (attempts < 3) {
          return Promise.resolve(E.left(Errors.infrastructure('NET' as any, 'Network error')));
        }
        return Promise.resolve(E.right(42));
      };

      const retried = withRetry({ maxAttempts: 3, initialDelayMs: 10 })(task);

      const resultPromise = retried();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(attempts).toBe(3);
      expect(E.isRight(result)).toBe(true);
    });

    it('respects maxAttempts', async () => {
      let attempts = 0;
      const task: TE.TaskEither<ReturnType<typeof Errors.infrastructure>, number> = () => {
        attempts++;
        return Promise.resolve(E.left(Errors.infrastructure('NET' as any, 'Always fails')));
      };

      const retried = withRetry({ maxAttempts: 2, initialDelayMs: 10 })(task);

      const resultPromise = retried();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(attempts).toBe(2);
      expect(E.isLeft(result)).toBe(true);
    });

    it('does not retry validation errors by default', async () => {
      let attempts = 0;
      const task: TE.TaskEither<ReturnType<typeof Errors.validation>, number> = () => {
        attempts++;
        return Promise.resolve(E.left(Errors.validation('field', 'Invalid')));
      };

      const retried = withRetry({ maxAttempts: 3 })(task);
      await retried();

      expect(attempts).toBe(1); // No retry
    });
  });

  describe('withTimeout', () => {
    it('returns result if completes in time', async () => {
      const task = TE.right(42);
      const timed = withTimeout<number>(1000)(task);

      const result = await timed();
      expect(E.isRight(result)).toBe(true);
    });

    it('returns timeout error if too slow', async () => {
      const slowTask: TE.TaskEither<never, number> = () =>
        new Promise((resolve) => setTimeout(() => resolve(E.right(42)), 500));

      const timed = withTimeout<number>(10)(slowTask);
      const result = await timed();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('InfrastructureError');
        expect((result.left as any).code).toBe('TIMEOUT');
      }
    });

    it('allows custom timeout error', async () => {
      const slowTask: TE.TaskEither<never, number> = () =>
        new Promise((resolve) => setTimeout(() => resolve(E.right(42)), 500));

      const customError = Errors.infrastructure('CUSTOM_TIMEOUT' as any, 'Too slow!');
      const timed = withTimeout<number>(10, customError)(slowTask);
      const result = await timed();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect((result.left as any).code).toBe('CUSTOM_TIMEOUT');
      }
    });
  });
});

describe('Option Helpers', () => {
  describe('fromOption', () => {
    it('converts Some to Right', async () => {
      const option = O.some(42);
      const result = await fromOption(() => Errors.validation('test', 'Missing'))(option)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBe(42);
      }
    });

    it('converts None to Left', async () => {
      const option = O.none;
      const result = await fromOption(() => Errors.validation('test', 'Missing'))(option)();

      expect(E.isLeft(result)).toBe(true);
    });
  });

  describe('fromNullable', () => {
    it('converts value to Right', async () => {
      const result = await fromNullable(42, () => Errors.validation('test', 'Missing'))();
      expect(E.isRight(result)).toBe(true);
    });

    it('converts null to Left', async () => {
      const result = await fromNullable(null, () => Errors.validation('test', 'Missing'))();
      expect(E.isLeft(result)).toBe(true);
    });

    it('converts undefined to Left', async () => {
      const result = await fromNullable(undefined, () => Errors.validation('test', 'Missing'))();
      expect(E.isLeft(result)).toBe(true);
    });
  });
});

describe('Sequencing Helpers', () => {
  describe('sequenceResults', () => {
    it('collects all successful results', async () => {
      const tasks = [TE.right(1), TE.right(2), TE.right(3)];
      const result = await sequenceResults(tasks)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual([1, 2, 3]);
      }
    });

    it('fails on first error', async () => {
      const tasks = [
        TE.right(1),
        TE.left(Errors.validation('test', 'Error at 2')),
        TE.right(3),
      ];
      const result = await sequenceResults(tasks)();

      expect(E.isLeft(result)).toBe(true);
    });
  });

  describe('parallelResults', () => {
    it('runs tasks in parallel', async () => {
      const order: number[] = [];
      const tasks = [
        pipe(
          TE.right(1),
          TE.map((v) => {
            order.push(v);
            return v;
          })
        ),
        pipe(
          TE.right(2),
          TE.map((v) => {
            order.push(v);
            return v;
          })
        ),
      ];

      const result = await parallelResults(tasks)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual([1, 2]);
      }
    });
  });
});

describe('Error Recovery', () => {
  describe('recoverWith', () => {
    it('recovers from matching error', async () => {
      const task = TE.left(Errors.infrastructure('NOT_FOUND' as any, 'Missing'));
      const recovered = recoverWith<number>(
        (e) => e._tag === 'InfrastructureError' && (e as any).code === 'NOT_FOUND',
        0
      )(task);

      const result = await recovered();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBe(0);
      }
    });

    it('does not recover from non-matching error', async () => {
      const task = TE.left(Errors.validation('test', 'Invalid'));
      const recovered = recoverWith<number>(
        (e) => e._tag === 'InfrastructureError',
        0
      )(task);

      const result = await recovered();
      expect(E.isLeft(result)).toBe(true);
    });
  });

  describe('mapError', () => {
    it('transforms errors', async () => {
      const task = TE.left(Errors.infrastructure('NET' as any, 'Network'));
      const mapped = mapError(
        (e) => Errors.infrastructure('WRAPPED' as any, `Wrapped: ${(e as any).message}`)
      )(task);

      const result = await mapped();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect((result.left as any).message).toContain('Wrapped:');
      }
    });
  });
});

describe('Idempotency', () => {
  describe('withIdempotency', () => {
    it('executes task when key not found', async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const task = TE.right({ id: '123' });
      const idempotent = withIdempotency(store, 'test-key')(task);

      const result = await idempotent();

      expect(store.get).toHaveBeenCalledWith('test-key');
      expect(store.set).toHaveBeenCalledWith('test-key', { id: '123' }, 86400);
      expect(E.isRight(result)).toBe(true);
    });

    it('returns idempotency error when key exists', async () => {
      const existingResult = { id: '123' };
      const store = {
        get: vi.fn().mockResolvedValue(existingResult),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const task = TE.right({ id: '456' });
      const idempotent = withIdempotency(store, 'test-key')(task);

      const result = await idempotent();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('IdempotencyError');
      }
      expect(store.set).not.toHaveBeenCalled();
    });
  });
});

describe('UUID Generation', () => {
  describe('generateId', () => {
    it('generates valid UUIDs', () => {
      fc.assert(
        fc.property(fc.constant(null), () => {
          const id = generateId();
          // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
          expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );
        }),
        { numRuns: 100 }
      );
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
      expect(ids.size).toBe(1000);
    });
  });

  describe('generateIdempotencyKey', () => {
    it('includes prefix', () => {
      const key = generateIdempotencyKey('booking');
      expect(key).toMatch(/^booking_[0-9a-f-]+$/i);
    });

    it('defaults to "idem" prefix', () => {
      const key = generateIdempotencyKey();
      expect(key).toMatch(/^idem_[0-9a-f-]+$/i);
    });
  });
});

describe('Property-based tests', () => {
  describe('validateWith', () => {
    it('round-trips valid strings', () => {
      fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1 }), async (s) => {
          const schema = z.string().min(1);
          const result = await validateWith(schema, s)();
          expect(E.isRight(result)).toBe(true);
          if (E.isRight(result)) {
            expect(result.right).toBe(s);
          }
        })
      );
    });

    it('rejects invalid emails', () => {
      fc.assert(
        fc.asyncProperty(
          fc.string().filter((s) => !s.includes('@') || !s.includes('.')),
          async (s) => {
            const schema = z.string().email();
            const result = await validateWith(schema, s)();
            expect(E.isLeft(result)).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('fromNullable', () => {
    it('always succeeds for non-null values', () => {
      fc.assert(
        fc.asyncProperty(
          fc.anything().filter((x) => x !== null && x !== undefined),
          async (value) => {
            const result = await fromNullable(
              value,
              () => Errors.validation('test', 'Missing')
            )();
            expect(E.isRight(result)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
