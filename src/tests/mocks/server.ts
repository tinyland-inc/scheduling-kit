import { beforeAll, afterEach, afterAll } from 'vitest';
/**
 * MSW Server Setup
 * Mock Service Worker server for Node.js testing
 */

import { setupServer } from 'msw/node';
import { acuityHandlers } from './handlers/acuity.js';
import { paypalHandlers } from './handlers/paypal.js';
import { stripeHandlers } from './handlers/stripe.js';

/**
 * Combined handlers for all services
 */
export const handlers = [...acuityHandlers, ...paypalHandlers, ...stripeHandlers];

/**
 * MSW server instance
 * Use in tests with beforeAll/afterAll/afterEach hooks
 */
export const server = setupServer(...handlers);

/**
 * Server lifecycle helpers for vitest
 *
 * Usage:
 * ```typescript
 * import { server } from './mocks/server.js';
 * import { setupMswServer } from './mocks/server.js';
 *
 * setupMswServer(); // In beforeAll/afterAll/afterEach
 * ```
 */
export const setupMswServer = () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'warn' });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });
};

/**
 * Add runtime request handlers (for test-specific scenarios)
 */
export const addHandler = server.use.bind(server);

/**
 * Reset to default handlers
 */
export const resetHandlers = server.resetHandlers.bind(server);

/**
 * Get list of intercepted requests (for debugging)
 */
export const listHandlers = server.listHandlers.bind(server);
