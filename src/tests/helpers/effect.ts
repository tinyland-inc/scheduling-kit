/**
 * Effect Test Helpers
 * Assertion utilities for Effect types (replaces fp-ts helpers)
 */

import { expect } from 'vitest';
import { Effect, Exit, Cause } from 'effect';
import type { SchedulingError, SchedulingResult } from '../../core/types.js';

// =============================================================================
// EFFECT ASSERTIONS (async — most common)
// =============================================================================

/**
 * Run an Effect and assert it succeeds, returning the value
 */
export const expectSuccess = async <A>(effect: SchedulingResult<A>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === 'Some') {
    expect.unreachable(`Expected success but got failure: ${JSON.stringify(failure.value)}`);
  }
  expect.unreachable(`Expected success but got defect: ${Cause.pretty(exit.cause)}`);
  throw new Error('Unreachable');
};

/**
 * Run an Effect and assert it fails, returning the error
 */
export const expectFailure = async <A>(effect: SchedulingResult<A>): Promise<SchedulingError> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === 'Some') {
      return failure.value;
    }
    expect.unreachable(`Expected typed failure but got defect: ${Cause.pretty(exit.cause)}`);
  }
  expect.unreachable(`Expected failure but got success: ${JSON.stringify(exit.value)}`);
  throw new Error('Unreachable');
};

/**
 * Run an Effect and assert it fails with a specific error tag
 */
export const expectFailureTag = async <A>(
  effect: SchedulingResult<A>,
  expectedTag: SchedulingError['_tag']
): Promise<SchedulingError> => {
  const error = await expectFailure(effect);
  expect(error._tag, `Expected error tag '${expectedTag}' but got '${error._tag}'`).toBe(expectedTag);
  return error;
};

/**
 * Run an Effect and assert it succeeds with the expected value
 */
export const expectSuccessEquals = async <A>(
  effect: SchedulingResult<A>,
  expected: A
): Promise<void> => {
  const value = await expectSuccess(effect);
  expect(value).toEqual(expected);
};

// =============================================================================
// SCHEDULING-SPECIFIC ASSERTIONS
// =============================================================================

export const expectAcuityError = async <A>(
  effect: SchedulingResult<A>,
  expectedCode?: string
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'AcuityError');
  if (expectedCode && error._tag === 'AcuityError') {
    expect(error.code).toBe(expectedCode);
  }
  return error;
};

export const expectPaymentError = async <A>(
  effect: SchedulingResult<A>,
  expectedCode?: string,
  expectedRecoverable?: boolean
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'PaymentError');
  if (error._tag === 'PaymentError') {
    if (expectedCode) expect(error.code).toBe(expectedCode);
    if (expectedRecoverable !== undefined) expect(error.recoverable).toBe(expectedRecoverable);
  }
  return error;
};

export const expectValidationError = async <A>(
  effect: SchedulingResult<A>,
  expectedField?: string
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'ValidationError');
  if (expectedField && error._tag === 'ValidationError') {
    expect(error.field).toBe(expectedField);
  }
  return error;
};

export const expectReservationError = async <A>(
  effect: SchedulingResult<A>,
  expectedCode?: 'SLOT_TAKEN' | 'BLOCK_FAILED' | 'TIMEOUT'
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'ReservationError');
  if (expectedCode && error._tag === 'ReservationError') {
    expect(error.code).toBe(expectedCode);
  }
  return error;
};

export const expectInfrastructureError = async <A>(
  effect: SchedulingResult<A>,
  expectedCode?: 'NETWORK' | 'TIMEOUT' | 'REDIS' | 'UNKNOWN'
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'InfrastructureError');
  if (expectedCode && error._tag === 'InfrastructureError') {
    expect(error.code).toBe(expectedCode);
  }
  return error;
};

// =============================================================================
// BACKWARD COMPAT — aliases for tests that used the old names
// =============================================================================

/** @deprecated Use expectSuccess */
export const expectRightAsync = expectSuccess;
/** @deprecated Use expectFailure */
export const expectLeftAsync = expectFailure;
/** @deprecated Use expectFailureTag */
export const expectLeftTagAsync = expectFailureTag;
/** @deprecated Use expectSuccessEquals */
export const expectRightEqualsAsync = expectSuccessEquals;
