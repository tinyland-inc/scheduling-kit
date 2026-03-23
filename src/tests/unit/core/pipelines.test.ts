/**
 * Tests for core/pipelines.ts
 * Orchestration pipeline tests with mock adapters
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as TE from 'fp-ts/TaskEither';
import * as E from 'fp-ts/Either';
import {
  completeBookingWithAltPayment,
  getAvailabilityWithService,
  getTimeSlotsWithService,
  cancelBookingWithRefund,
  createSchedulingKit,
  type PipelineContext,
  type BookingPipelineInput,
} from '../../../core/pipelines.js';
import { Errors } from '../../../core/types.js';
import type { SchedulingAdapter } from '../../../adapters/types.js';
import type { PaymentAdapter } from '../../../payments/types.js';
import {
  createService,
  createProvider,
  createBooking,
  createBookingRequest,
  createReservation,
  createPaymentIntent,
  createPaymentResult,
  createTimeSlot,
  createDaySlots,
} from '../../helpers/factories.js';
import {
  expectRightAsync,
  expectLeftAsync,
  expectLeftTagAsync,
} from '../../helpers/fp-ts.js';

// =============================================================================
// MOCK ADAPTERS
// =============================================================================

const createMockScheduler = (): SchedulingAdapter => ({
  name: 'mock',

  // Services
  getServices: vi.fn(() => TE.right([createService()])),
  getService: vi.fn((id) => TE.right(createService({ id }))),

  // Providers
  getProviders: vi.fn(() => TE.right([createProvider()])),
  getProvider: vi.fn((id) => TE.right(createProvider({ id }))),
  getProvidersForService: vi.fn(() => TE.right([createProvider()])),

  // Availability
  getAvailableDates: vi.fn(() =>
    TE.right([
      { date: '2026-02-15', slots: 5 },
      { date: '2026-02-16', slots: 3 },
    ])
  ),
  getAvailableSlots: vi.fn(() => TE.right(createDaySlots('2026-02-15', '67890'))),
  checkSlotAvailability: vi.fn(() => TE.right(true)),

  // Reservations
  createReservation: vi.fn(() => TE.right(createReservation())),
  releaseReservation: vi.fn(() => TE.right(undefined)),

  // Bookings
  createBooking: vi.fn(() => TE.right(createBooking())),
  createBookingWithPaymentRef: vi.fn((_, ref, processor) =>
    TE.right(createBooking({ paymentRef: `[${processor.toUpperCase()}] Transaction: ${ref}` }))
  ),
  getBooking: vi.fn(() => TE.right(createBooking())),
  cancelBooking: vi.fn(() => TE.right(undefined)),
  rescheduleBooking: vi.fn(() => TE.right(createBooking())),

  // Clients
  findOrCreateClient: vi.fn(() => TE.right({ id: 'client-1', isNew: true })),
  getClientByEmail: vi.fn(() => TE.right(null)),
});

const createMockPaymentAdapter = (name = 'cash'): PaymentAdapter => ({
  name,
  displayName: name.charAt(0).toUpperCase() + name.slice(1),
  isAvailable: vi.fn(() => TE.right(true)),
  createIntent: vi.fn(() => TE.right(createPaymentIntent())),
  capturePayment: vi.fn(() => TE.right(createPaymentResult())),
  cancelIntent: vi.fn(() => TE.right(undefined)),
  refund: vi.fn(() =>
    TE.right({
      success: true,
      refundId: 'refund_12345',
      originalTransactionId: 'txn_test_12345',
      amount: 20000,
      currency: 'USD',
      timestamp: new Date().toISOString(),
    })
  ),
  verifyWebhook: vi.fn(() => TE.right(true)),
  parseWebhook: vi.fn(() =>
    TE.right({
      type: 'payment.completed' as const,
      intentId: 'pi_test_12345',
      transactionId: 'txn_test_12345',
      amount: 20000,
      currency: 'USD',
      timestamp: new Date().toISOString(),
      raw: '{}',
    })
  ),
  getClientConfig: () => ({
    name: 'cash',
    displayName: 'Cash',
    environment: 'production' as const,
    supportedCurrencies: ['USD'],
  }),
});

// =============================================================================
// COMPLETE BOOKING PIPELINE TESTS
// =============================================================================

describe('completeBookingWithAltPayment', () => {
  let scheduler: SchedulingAdapter;
  let paymentAdapter: PaymentAdapter;
  let ctx: PipelineContext;
  let input: BookingPipelineInput;

  beforeEach(() => {
    scheduler = createMockScheduler();
    paymentAdapter = createMockPaymentAdapter();
    ctx = {
      scheduler,
      payments: new Map([['cash', paymentAdapter]]),
      correlationId: 'test-correlation-id',
    };
    input = {
      request: createBookingRequest(),
      paymentMethod: 'cash',
    };
  });

  it('completes booking successfully with all steps', async () => {
    const result = await expectRightAsync(completeBookingWithAltPayment(ctx, input));

    expect(result.booking).toBeDefined();
    expect(result.payment).toBeDefined();
    expect(result.payment.success).toBe(true);

    // Verify all steps were called
    expect(scheduler.getService).toHaveBeenCalledWith(input.request.serviceId);
    expect(scheduler.checkSlotAvailability).toHaveBeenCalled();
    expect(scheduler.createReservation).toHaveBeenCalled();
    expect(paymentAdapter.createIntent).toHaveBeenCalled();
    expect(paymentAdapter.capturePayment).toHaveBeenCalled();
    expect(scheduler.createBookingWithPaymentRef).toHaveBeenCalled();
    expect(scheduler.releaseReservation).toHaveBeenCalled();
  });

  it('returns error for unknown payment method', async () => {
    input = { ...input, paymentMethod: 'unknown' };

    const error = await expectLeftTagAsync(
      completeBookingWithAltPayment(ctx, input),
      'PaymentError'
    );

    expect(error._tag).toBe('PaymentError');
    if (error._tag === 'PaymentError') {
      expect(error.code).toBe('INVALID_METHOD');
    }
  });

  it('returns validation error for invalid request', async () => {
    input = { ...input, request: { ...input.request, client: { ...input.request.client, email: 'invalid' } } };

    const error = await expectLeftTagAsync(
      completeBookingWithAltPayment(ctx, input),
      'ValidationError'
    );

    expect(error._tag).toBe('ValidationError');
  });

  it('returns reservation error when slot is taken', async () => {
    vi.mocked(scheduler.checkSlotAvailability).mockReturnValue(TE.right(false));

    const error = await expectLeftTagAsync(
      completeBookingWithAltPayment(ctx, input),
      'ReservationError'
    );

    expect(error._tag).toBe('ReservationError');
    if (error._tag === 'ReservationError') {
      expect(error.code).toBe('SLOT_TAKEN');
    }
  });

  it('releases reservation on payment intent failure', async () => {
    vi.mocked(paymentAdapter.createIntent).mockReturnValue(
      TE.left(Errors.payment('INTENT_FAILED', 'Failed to create intent', 'cash'))
    );

    await expectLeftAsync(completeBookingWithAltPayment(ctx, input));

    // Reservation should have been released
    expect(scheduler.releaseReservation).toHaveBeenCalled();
  });

  it('releases reservation on payment capture failure', async () => {
    vi.mocked(paymentAdapter.capturePayment).mockReturnValue(
      TE.left(Errors.payment('CAPTURE_FAILED', 'Failed to capture payment', 'cash'))
    );

    await expectLeftAsync(completeBookingWithAltPayment(ctx, input));

    expect(scheduler.releaseReservation).toHaveBeenCalled();
  });

  it('refunds payment on booking creation failure', async () => {
    vi.mocked(scheduler.createBookingWithPaymentRef).mockReturnValue(
      TE.left(Errors.acuity('BOOKING_FAILED', 'Failed to create booking'))
    );

    await expectLeftAsync(completeBookingWithAltPayment(ctx, input));

    // Payment should have been refunded
    expect(paymentAdapter.refund).toHaveBeenCalled();
    expect(scheduler.releaseReservation).toHaveBeenCalled();
  });

  it('continues without reservation if reservation fails', async () => {
    vi.mocked(scheduler.createReservation).mockReturnValue(
      TE.left(Errors.reservation('BLOCK_FAILED', 'Could not create block'))
    );

    const result = await expectRightAsync(completeBookingWithAltPayment(ctx, input));

    expect(result.booking).toBeDefined();
    expect(result.reservation).toBeUndefined();
  });
});

// =============================================================================
// AVAILABILITY PIPELINE TESTS
// =============================================================================

describe('getAvailabilityWithService', () => {
  let scheduler: SchedulingAdapter;

  beforeEach(() => {
    scheduler = createMockScheduler();
  });

  it('returns service with available dates', async () => {
    const result = await expectRightAsync(
      getAvailabilityWithService(scheduler, {
        serviceId: '12345',
        startDate: '2026-02-01',
        endDate: '2026-02-28',
      })
    );

    expect(result.service).toBeDefined();
    expect(result.dates.length).toBeGreaterThan(0);
    expect(scheduler.getService).toHaveBeenCalledWith('12345');
    expect(scheduler.getAvailableDates).toHaveBeenCalled();
  });

  it('passes provider ID when specified', async () => {
    await expectRightAsync(
      getAvailabilityWithService(scheduler, {
        serviceId: '12345',
        providerId: '67890',
        startDate: '2026-02-01',
        endDate: '2026-02-28',
      })
    );

    expect(scheduler.getAvailableDates).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: '67890' })
    );
  });

  it('propagates service not found error', async () => {
    vi.mocked(scheduler.getService).mockReturnValue(
      TE.left(Errors.acuity('NOT_FOUND', 'Service not found'))
    );

    const error = await expectLeftTagAsync(
      getAvailabilityWithService(scheduler, {
        serviceId: 'unknown',
        startDate: '2026-02-01',
        endDate: '2026-02-28',
      }),
      'AcuityError'
    );

    expect(error._tag).toBe('AcuityError');
  });
});

// =============================================================================
// TIME SLOTS PIPELINE TESTS
// =============================================================================

describe('getTimeSlotsWithService', () => {
  let scheduler: SchedulingAdapter;

  beforeEach(() => {
    scheduler = createMockScheduler();
  });

  it('returns service with time slots', async () => {
    const result = await expectRightAsync(
      getTimeSlotsWithService(scheduler, {
        serviceId: '12345',
        date: '2026-02-15',
      })
    );

    expect(result.service).toBeDefined();
    expect(result.date).toBe('2026-02-15');
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it('propagates availability fetch error', async () => {
    vi.mocked(scheduler.getAvailableSlots).mockReturnValue(
      TE.left(Errors.acuity('API_ERROR', 'Failed to fetch slots'))
    );

    const error = await expectLeftAsync(
      getTimeSlotsWithService(scheduler, {
        serviceId: '12345',
        date: '2026-02-15',
      })
    );

    expect(error._tag).toBe('AcuityError');
  });
});

// =============================================================================
// CANCELLATION PIPELINE TESTS
// =============================================================================

describe('cancelBookingWithRefund', () => {
  let scheduler: SchedulingAdapter;
  let paymentAdapter: PaymentAdapter;
  let ctx: PipelineContext;

  beforeEach(() => {
    scheduler = createMockScheduler();
    paymentAdapter = createMockPaymentAdapter();
    ctx = {
      scheduler,
      payments: new Map([['cash', paymentAdapter]]),
      correlationId: 'test-correlation-id',
    };
  });

  it('cancels booking without refund', async () => {
    const result = await expectRightAsync(
      cancelBookingWithRefund(ctx, {
        bookingId: '100001',
        reason: 'Customer request',
        refund: false,
      })
    );

    expect(result.cancelled).toBe(true);
    expect(result.refund).toBeUndefined();
    expect(scheduler.cancelBooking).toHaveBeenCalledWith('100001', 'Customer request');
    expect(paymentAdapter.refund).not.toHaveBeenCalled();
  });

  it('cancels booking with refund when payment ref exists', async () => {
    vi.mocked(scheduler.getBooking).mockReturnValue(
      TE.right(
        createBooking({
          paymentRef: '[CASH] Transaction: cash_12345',
        })
      )
    );

    const result = await expectRightAsync(
      cancelBookingWithRefund(ctx, {
        bookingId: '100001',
        refund: true,
      })
    );

    expect(result.cancelled).toBe(true);
    expect(result.refund?.success).toBe(true);
    expect(result.refund?.refundId).toBeDefined();
    expect(paymentAdapter.refund).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'cash_12345' })
    );
  });

  it('returns success with failed refund when processor not found', async () => {
    vi.mocked(scheduler.getBooking).mockReturnValue(
      TE.right(
        createBooking({
          paymentRef: '[UNKNOWN] Transaction: unknown_12345',
        })
      )
    );

    const result = await expectRightAsync(
      cancelBookingWithRefund(ctx, {
        bookingId: '100001',
        refund: true,
      })
    );

    expect(result.cancelled).toBe(true);
    expect(result.refund?.success).toBe(false);
  });

  it('returns success with failed refund when transaction ID not found', async () => {
    vi.mocked(scheduler.getBooking).mockReturnValue(
      TE.right(
        createBooking({
          paymentRef: '[CASH] No transaction here',
        })
      )
    );

    const result = await expectRightAsync(
      cancelBookingWithRefund(ctx, {
        bookingId: '100001',
        refund: true,
      })
    );

    expect(result.cancelled).toBe(true);
    expect(result.refund?.success).toBe(false);
  });

  it('propagates booking not found error', async () => {
    vi.mocked(scheduler.getBooking).mockReturnValue(
      TE.left(Errors.acuity('NOT_FOUND', 'Booking not found'))
    );

    const error = await expectLeftTagAsync(
      cancelBookingWithRefund(ctx, { bookingId: 'unknown' }),
      'AcuityError'
    );

    expect(error._tag).toBe('AcuityError');
  });
});

// =============================================================================
// SCHEDULING KIT FACTORY TESTS
// =============================================================================

describe('createSchedulingKit', () => {
  let scheduler: SchedulingAdapter;
  let paymentAdapter: PaymentAdapter;

  beforeEach(() => {
    scheduler = createMockScheduler();
    paymentAdapter = createMockPaymentAdapter();
  });

  it('creates kit with all methods', () => {
    const kit = createSchedulingKit(scheduler, [paymentAdapter]);

    expect(kit.scheduler).toBe(scheduler);
    expect(kit.payments.get('cash')).toBe(paymentAdapter);
    expect(kit.completeBooking).toBeDefined();
    expect(kit.getAvailability).toBeDefined();
    expect(kit.getTimeSlots).toBeDefined();
    expect(kit.cancelBooking).toBeDefined();
  });

  it('registers multiple payment adapters', () => {
    const venmo = createMockPaymentAdapter('venmo');
    const zelle = createMockPaymentAdapter('zelle');
    const kit = createSchedulingKit(scheduler, [paymentAdapter, venmo, zelle]);

    expect(kit.payments.get('cash')).toBeDefined();
    expect(kit.payments.get('venmo')).toBeDefined();
    expect(kit.payments.get('zelle')).toBeDefined();
    expect(kit.payments.getAll().length).toBe(3);
  });

  it('completeBooking delegates to pipeline', async () => {
    const kit = createSchedulingKit(scheduler, [paymentAdapter]);

    const result = await expectRightAsync(
      kit.completeBooking(createBookingRequest(), 'cash')
    );

    expect(result.booking).toBeDefined();
  });

  it('getAvailability delegates to pipeline', async () => {
    const kit = createSchedulingKit(scheduler, []);

    const result = await expectRightAsync(
      kit.getAvailability({
        serviceId: '12345',
        startDate: '2026-02-01',
        endDate: '2026-02-28',
      })
    );

    expect(result.service).toBeDefined();
    expect(result.dates).toBeDefined();
  });

  it('getTimeSlots delegates to pipeline', async () => {
    const kit = createSchedulingKit(scheduler, []);

    const result = await expectRightAsync(
      kit.getTimeSlots({
        serviceId: '12345',
        date: '2026-02-15',
      })
    );

    expect(result.slots).toBeDefined();
  });

  it('cancelBooking delegates to pipeline', async () => {
    const kit = createSchedulingKit(scheduler, [paymentAdapter]);

    const result = await expectRightAsync(
      kit.cancelBooking({ bookingId: '100001' })
    );

    expect(result.cancelled).toBe(true);
  });
});
