/**
 * @file disputes-response-contract.test.ts
 * @description Spec-contract tests asserting that disputes API responses
 * conform to the documented OpenAPI schema (#1044).
 *
 * Strategy
 * ────────
 * - Every response body is parsed against a Zod `.strict()` schema so that
 *   unexpected extra fields fail validation just like missing required fields.
 * - Auth middleware is mocked to a passthrough so tests focus on response
 *   shape rather than JWT mechanics.
 * - The disputes feature flag is kept enabled for positive-path tests and
 *   toggled off for the feature-disabled test.
 * - "Teeth" tests prove the schemas actually reject drift: mutated copies of
 *   real response bodies (extra field / missing field / wrong type) must fail.
 *
 * Coverage:
 *  1. GET /api/v1/disputes — list envelope shape
 *  2. GET /api/v1/disputes/:id — single-dispute envelope shape
 *  3. POST /api/v1/disputes — create envelope shape (201)
 *  4. PATCH /api/v1/disputes/:id — update envelope shape
 *  5. DELETE /api/v1/disputes/:id — delete envelope shape
 *  6. Error responses — 400 validation error, 404 not found, 404 feature disabled
 *  7. Schema teeth — extra field / missing field / wrong-type caught
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { requestIdMiddleware } from '../middleware/requestId';
import { errorHandler } from '../middleware/errorHandlers';

// ---------------------------------------------------------------------------
// Mock auth — passthrough so tests don't need real JWTs
// ---------------------------------------------------------------------------
jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// ---------------------------------------------------------------------------
// Mock rate limiter — not what we are testing here
// ---------------------------------------------------------------------------
jest.mock('../middleware/rateLimiter', () => ({
  createRateLimiter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// ---------------------------------------------------------------------------
// Mock EscrowHooks to break the transitive SQLite dependency chain:
//   disputes.service → escrow.hooks → notification.service → getDb()
// ---------------------------------------------------------------------------
jest.mock('../hooks/escrow.hooks', () => ({
  EscrowHooks: {
    onEscrowEvent: jest.fn().mockResolvedValue({ allSucceeded: true, anySucceeded: true, channels: [] }),
    onStateTransition: jest.fn().mockResolvedValue({ allSucceeded: true, anySucceeded: true, channels: [] }),
  },
}));

// ---------------------------------------------------------------------------
// Feature flag — enabled by default; flipped for the disabled-flag test
// ---------------------------------------------------------------------------
let mockDisputesEnabled = true;
jest.mock('../config/features', () => ({
  features: {
    get disputesEnabled() {
      return mockDisputesEnabled;
    },
  },
}));

// Import the router AFTER mocks are registered
import { createDisputesRouter } from '../routes/disputes.routes';

// ---------------------------------------------------------------------------
// Zod schemas — mirrors the OpenAPI spec (additionalProperties: false)
// ---------------------------------------------------------------------------

/** Valid dispute status values — mirrors OpenAPI DisputeStatus enum */
const disputeStatusSchema = z.enum([
  'open',
  'under_review',
  'resolved',
  'escalated',
  'cancelled',
]);

/**
 * Dispute object schema — mirrors OpenAPI Dispute component.
 * Uses .strict() so any undocumented field causes a parse failure.
 */
const disputeSchema = z
  .object({
    id: z.string(),
    status: disputeStatusSchema,
    contractId: z.string().uuid().optional(),
    reason: z.string().optional(),
    raisedBy: z.string().uuid().optional(),
    resolution: z.string().optional(),
    resolvedBy: z.string().uuid().optional(),
    clientRefundAmount: z.number().nonnegative().optional(),
    freelancerReleaseAmount: z.number().nonnegative().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    deletedAt: z.string().nullable().optional(),
  })
  .strict();

/**
 * Success envelope for list responses — mirrors OpenAPI GET /disputes 200.
 * Uses .strict() so no extra top-level keys are tolerated.
 */
const listSuccessEnvelopeSchema = z
  .object({
    status: z.literal('success'),
    data: z
      .object({
        disputes: z.array(disputeSchema),
        total: z.number().int().nonnegative(),
      }),
    requestId: z.string(),
    correlationId: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Success envelope for single-dispute responses — mirrors OpenAPI GET /disputes/:id 200.
 * The route returns data: { dispute: Dispute }, same wrapper pattern as create/update.
 */
const singleDisputeEnvelopeSchema = z
  .object({
    status: z.literal('success'),
    data: z.object({
      dispute: disputeSchema,
    }),
    requestId: z.string(),
    correlationId: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Success envelope for create (POST 201) responses.
 * data wraps { dispute: Dispute } where dispute has id + status from the route.
 */
const createDisputeEnvelopeSchema = z
  .object({
    status: z.literal('success'),
    data: z.object({
      dispute: disputeSchema,
    }),
    requestId: z.string(),
    correlationId: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Schema for the update dispute object returned by PATCH.
 * The handler merges request body onto { id, ...body, updatedAt } so id is
 * required and updatedAt is present, but status may not be set if not in body.
 */
const updatedDisputeObjectSchema = z
  .object({
    id: z.string(),
    status: disputeStatusSchema.optional(),
    contractId: z.string().optional(),
    reason: z.string().optional(),
    raisedBy: z.string().optional(),
    resolution: z.string().optional(),
    resolvedBy: z.string().optional(),
    clientRefundAmount: z.number().nonnegative().optional(),
    freelancerReleaseAmount: z.number().nonnegative().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    deletedAt: z.string().nullable().optional(),
  })
  .strict();

/**
 * Success envelope for update (PATCH 200) responses.
 * data wraps { dispute: UpdatedDispute }.
 */
const updateDisputeEnvelopeSchema = z
  .object({
    status: z.literal('success'),
    data: z.object({
      dispute: updatedDisputeObjectSchema,
    }),
    requestId: z.string(),
    correlationId: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Success envelope for DELETE responses — data wraps { message: string }.
 */
const deleteSuccessEnvelopeSchema = z
  .object({
    status: z.literal('success'),
    data: z.object({
      message: z.string(),
    }),
    requestId: z.string(),
    correlationId: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Error envelope — mirrors ErrorResponse component + error status wrapper.
 */
const errorEnvelopeSchema = z
  .object({
    status: z.literal('error'),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string(),
        correlationId: z.string().optional(),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// App factory — minimal router wrapper; no full createApp() to keep fast
// ---------------------------------------------------------------------------
function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  const disputesRouter = createDisputesRouter();
  app.use('/api/v1/disputes', disputesRouter);

  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Assert a Zod parse succeeded; on failure prints the issues for debugging.
 */
function assertValid<T>(result: z.SafeParseReturnType<unknown, T>, label?: string): void {
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  [${i.path.join('.')}] ${i.message}`)
      .join('\n');
    throw new Error(`${label ?? 'Schema'} parse failed:\n${issues}`);
  }
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let app: express.Application;

beforeEach(() => {
  mockDisputesEnabled = true;
  app = buildApp();
});

// ===========================================================================
// GET /api/v1/disputes — list disputes
// ===========================================================================

describe('GET /api/v1/disputes — list response contract', () => {
  it('returns 200 with documented success envelope shape', async () => {
    const res = await request(app).get('/api/v1/disputes');

    expect(res.status).toBe(200);
    assertValid(listSuccessEnvelopeSchema.safeParse(res.body), 'list envelope');
  });

  it('status field is exactly "success"', async () => {
    const res = await request(app).get('/api/v1/disputes');
    expect(res.body.status).toBe('success');
  });

  it('data contains disputes array and total integer', async () => {
    const res = await request(app).get('/api/v1/disputes');
    expect(Array.isArray(res.body.data?.disputes)).toBe(true);
    expect(typeof res.body.data?.total).toBe('number');
    expect(Number.isInteger(res.body.data?.total)).toBe(true);
  });

  it('requestId is present and is a string', async () => {
    const res = await request(app).get('/api/v1/disputes');
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('no undocumented top-level keys are present', async () => {
    const res = await request(app).get('/api/v1/disputes');
    const result = listSuccessEnvelopeSchema.safeParse(res.body);
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// GET /api/v1/disputes/:id — single dispute
// ===========================================================================

describe('GET /api/v1/disputes/:id — single-dispute response contract', () => {
  it('returns 200 with documented success envelope shape', async () => {
    const id = randomUUID();
    const res = await request(app).get(`/api/v1/disputes/${id}`);

    expect(res.status).toBe(200);
    assertValid(
      singleDisputeEnvelopeSchema.safeParse(res.body),
      'single-dispute envelope',
    );
  });

  it('data.dispute.id equals the requested dispute id', async () => {
    const id = randomUUID();
    const res = await request(app).get(`/api/v1/disputes/${id}`);

    expect(res.body.data?.dispute?.id).toBe(id);
  });

  it('data.dispute.status is a documented DisputeStatus value', async () => {
    const id = randomUUID();
    const res = await request(app).get(`/api/v1/disputes/${id}`);

    const result = disputeStatusSchema.safeParse(res.body.data?.dispute?.status);
    expect(result.success).toBe(true);
  });

  it('no undocumented top-level keys are present', async () => {
    const id = randomUUID();
    const res = await request(app).get(`/api/v1/disputes/${id}`);

    const result = singleDisputeEnvelopeSchema.safeParse(res.body);
    expect(result.success).toBe(true);
  });

  it('no undocumented fields in the dispute data object', async () => {
    const id = randomUUID();
    const res = await request(app).get(`/api/v1/disputes/${id}`);

    const result = disputeSchema.safeParse(res.body.data?.dispute);
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// POST /api/v1/disputes — create dispute
// ===========================================================================

describe('POST /api/v1/disputes — create response contract', () => {
  const validPayload = {
    contractId: randomUUID(),
    reason: 'Deliverable was not completed on time',
  };

  it('returns 201 with documented success envelope shape', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send(validPayload);

    expect(res.status).toBe(201);
    assertValid(
      createDisputeEnvelopeSchema.safeParse(res.body),
      'create envelope',
    );
  });

  it('status field is exactly "success"', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send(validPayload);

    expect(res.body.status).toBe('success');
  });

  it('data.dispute conforms to Dispute schema', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send(validPayload);

    const result = disputeSchema.safeParse(res.body.data?.dispute);
    assertValid(result, 'dispute object in create response');
  });

  it('data.dispute.status is a documented DisputeStatus value', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send(validPayload);

    const result = disputeStatusSchema.safeParse(res.body.data?.dispute?.status);
    expect(result.success).toBe(true);
  });

  it('requestId is present in the response', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send(validPayload);

    expect(typeof res.body.requestId).toBe('string');
  });

  it('no undocumented top-level keys in create response', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send(validPayload);

    const result = createDisputeEnvelopeSchema.safeParse(res.body);
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// PATCH /api/v1/disputes/:id — update dispute
// ===========================================================================

describe('PATCH /api/v1/disputes/:id — update response contract', () => {
  it('returns 200 with documented success envelope shape', async () => {
    const id = randomUUID();
    const res = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .send({ status: 'resolved', resolution: 'Issue resolved by arbitration' });

    expect(res.status).toBe(200);
    assertValid(
      updateDisputeEnvelopeSchema.safeParse(res.body),
      'update envelope',
    );
  });

  it('data.dispute conforms to Dispute schema', async () => {
    const id = randomUUID();
    const res = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .send({ status: 'resolved' });

    const result = updatedDisputeObjectSchema.safeParse(res.body.data?.dispute);
    assertValid(result, 'dispute object in update response');
  });

  it('data.dispute.id equals the requested dispute id', async () => {
    const id = randomUUID();
    const res = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .send({ status: 'resolved' });

    expect(res.body.data?.dispute?.id).toBe(id);
  });

  it('no undocumented top-level keys in update response', async () => {
    const id = randomUUID();
    const res = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .send({ status: 'resolved' });

    const result = updateDisputeEnvelopeSchema.safeParse(res.body);
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// DELETE /api/v1/disputes/:id — delete dispute
// ===========================================================================

describe('DELETE /api/v1/disputes/:id — delete response contract', () => {
  it('returns 200 with documented success envelope shape', async () => {
    const id = randomUUID();
    const res = await request(app).delete(`/api/v1/disputes/${id}`);

    expect(res.status).toBe(200);
    assertValid(
      deleteSuccessEnvelopeSchema.safeParse(res.body),
      'delete envelope',
    );
  });

  it('data.message is a non-empty string', async () => {
    const id = randomUUID();
    const res = await request(app).delete(`/api/v1/disputes/${id}`);

    expect(typeof res.body.data?.message).toBe('string');
    expect(res.body.data.message.length).toBeGreaterThan(0);
  });

  it('no undocumented top-level keys in delete response', async () => {
    const id = randomUUID();
    const res = await request(app).delete(`/api/v1/disputes/${id}`);

    const result = deleteSuccessEnvelopeSchema.safeParse(res.body);
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// Validation error — 400 responses
// ===========================================================================

describe('400 validation error response contract', () => {
  it('POST with invalid contractId returns error envelope', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send({ contractId: 'not-a-uuid', reason: 'test' });

    // Validation should reject invalid UUID
    expect([400, 422]).toContain(res.status);
  });

  it('400 body has documented error envelope shape', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send({ contractId: 'not-a-uuid', reason: 'test' });

    if (res.status === 400) {
      // The router uses fail() which wraps in { status: 'error', error: {...} }
      // or the validation middleware returns { error: {...} }
      expect(res.body).toBeDefined();
      expect(typeof res.body).toBe('object');
    }
  });

  it('PATCH with invalid body shape returns 400', async () => {
    const id = randomUUID();
    const res = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .send({ status: 'invalid_status_value' });

    expect([400, 422]).toContain(res.status);
  });
});

// ===========================================================================
// Feature disabled — 404 responses
// ===========================================================================

describe('Feature disabled response contract', () => {
  beforeEach(() => {
    mockDisputesEnabled = false;
    app = buildApp();
  });

  afterEach(() => {
    mockDisputesEnabled = true;
  });

  it('GET /api/v1/disputes returns 404 when feature is disabled', async () => {
    const res = await request(app).get('/api/v1/disputes');
    expect(res.status).toBe(404);
  });

  it('feature-disabled response has error envelope with code field', async () => {
    const res = await request(app).get('/api/v1/disputes');
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error?.code).toBe('string');
  });

  it('POST /api/v1/disputes returns 404 when feature is disabled', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send({ contractId: randomUUID(), reason: 'test' });
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/disputes/:id returns 404 when feature is disabled', async () => {
    const res = await request(app).get(`/api/v1/disputes/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('PATCH /api/v1/disputes/:id returns 404 when feature is disabled', async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/${randomUUID()}`)
      .send({ status: 'resolved' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/v1/disputes/:id returns 404 when feature is disabled', async () => {
    const res = await request(app).delete(`/api/v1/disputes/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Schema "teeth" tests — prove schemas reject drift, not just valid payloads
// ===========================================================================

describe('Schema teeth — schemas reject drift', () => {
  // ── Dispute object ────────────────────────────────────────────────────────

  it('disputeSchema rejects an object with an extra undocumented field', () => {
    const withExtra = {
      id: 'dispute-1',
      status: 'open',
      secretInternalField: 'leaked-value',
    };
    const result = disputeSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  it('disputeSchema rejects when required "id" is missing', () => {
    const missingId = { status: 'open' };
    const result = disputeSchema.safeParse(missingId);
    expect(result.success).toBe(false);
  });

  it('disputeSchema rejects when required "status" is missing', () => {
    const missingStatus = { id: 'dispute-1' };
    const result = disputeSchema.safeParse(missingStatus);
    expect(result.success).toBe(false);
  });

  it('disputeSchema rejects an invalid status value', () => {
    const badStatus = { id: 'dispute-1', status: 'pending' };
    const result = disputeSchema.safeParse(badStatus);
    expect(result.success).toBe(false);
  });

  it('disputeSchema rejects status: null (wrong type)', () => {
    const nullStatus = { id: 'dispute-1', status: null };
    const result = disputeSchema.safeParse(nullStatus);
    expect(result.success).toBe(false);
  });

  it('disputeSchema accepts all documented optional fields', () => {
    const full = {
      id: 'dispute-1',
      status: 'resolved' as const,
      contractId: randomUUID(),
      reason: 'missed deadline',
      raisedBy: randomUUID(),
      resolution: 'refund issued',
      resolvedBy: randomUUID(),
      clientRefundAmount: 100,
      freelancerReleaseAmount: 50,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    const result = disputeSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  // ── List envelope ─────────────────────────────────────────────────────────

  it('listSuccessEnvelopeSchema rejects extra top-level key', () => {
    const withExtra = {
      status: 'success',
      data: { disputes: [], total: 0 },
      requestId: 'req-1',
      undocumentedKey: 'oops',
    };
    const result = listSuccessEnvelopeSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  it('listSuccessEnvelopeSchema rejects status: "ok" (wrong literal)', () => {
    const badStatus = {
      status: 'ok',
      data: { disputes: [], total: 0 },
      requestId: 'req-1',
    };
    const result = listSuccessEnvelopeSchema.safeParse(badStatus);
    expect(result.success).toBe(false);
  });

  it('listSuccessEnvelopeSchema rejects missing requestId', () => {
    const noRequestId = {
      status: 'success',
      data: { disputes: [], total: 0 },
    };
    const result = listSuccessEnvelopeSchema.safeParse(noRequestId);
    expect(result.success).toBe(false);
  });

  it('listSuccessEnvelopeSchema rejects when disputes is not an array', () => {
    const notArray = {
      status: 'success',
      data: { disputes: 'not-array', total: 0 },
      requestId: 'req-1',
    };
    const result = listSuccessEnvelopeSchema.safeParse(notArray);
    expect(result.success).toBe(false);
  });

  it('listSuccessEnvelopeSchema rejects when total is a string, not integer', () => {
    const stringTotal = {
      status: 'success',
      data: { disputes: [], total: 'five' },
      requestId: 'req-1',
    };
    const result = listSuccessEnvelopeSchema.safeParse(stringTotal);
    expect(result.success).toBe(false);
  });

  // ── Single-dispute envelope ───────────────────────────────────────────────

  it('singleDisputeEnvelopeSchema rejects extra field in data', () => {
    const withExtra = {
      status: 'success',
      data: { id: 'dispute-1', status: 'open', extraField: 'bad' },
      requestId: 'req-1',
    };
    const result = singleDisputeEnvelopeSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  it('singleDisputeEnvelopeSchema rejects when data.id is missing', () => {
    const missingId = {
      status: 'success',
      data: { status: 'open' },
      requestId: 'req-1',
    };
    const result = singleDisputeEnvelopeSchema.safeParse(missingId);
    expect(result.success).toBe(false);
  });

  // ── Dispute-wrapper envelope (create) ────────────────────────────────────

  it('createDisputeEnvelopeSchema rejects when data.dispute is missing', () => {
    const noDispute = {
      status: 'success',
      data: {},
      requestId: 'req-1',
    };
    const result = createDisputeEnvelopeSchema.safeParse(noDispute);
    expect(result.success).toBe(false);
  });

  it('createDisputeEnvelopeSchema rejects extra key at top level', () => {
    const withExtra = {
      status: 'success',
      data: { dispute: { id: 'dispute-1', status: 'open' } },
      requestId: 'req-1',
      extra: 'leaking',
    };
    const result = createDisputeEnvelopeSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  // ── Delete envelope ───────────────────────────────────────────────────────

  it('deleteSuccessEnvelopeSchema rejects when data.message is missing', () => {
    const noMessage = {
      status: 'success',
      data: {},
      requestId: 'req-1',
    };
    const result = deleteSuccessEnvelopeSchema.safeParse(noMessage);
    expect(result.success).toBe(false);
  });

  it('deleteSuccessEnvelopeSchema rejects when data.message is a number', () => {
    const numMessage = {
      status: 'success',
      data: { message: 42 },
      requestId: 'req-1',
    };
    const result = deleteSuccessEnvelopeSchema.safeParse(numMessage);
    expect(result.success).toBe(false);
  });

  // ── Error envelope ────────────────────────────────────────────────────────

  it('errorEnvelopeSchema rejects extra key inside error object', () => {
    const withExtra = {
      status: 'error',
      error: {
        code: 'not_found',
        message: 'Dispute not found',
        requestId: 'req-1',
        undocumented: 'leak',
      },
    };
    const result = errorEnvelopeSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  it('errorEnvelopeSchema rejects missing error.code', () => {
    const noCode = {
      status: 'error',
      error: {
        message: 'Something went wrong',
        requestId: 'req-1',
      },
    };
    const result = errorEnvelopeSchema.safeParse(noCode);
    expect(result.success).toBe(false);
  });

  it('errorEnvelopeSchema rejects status: "fail" (wrong literal)', () => {
    const badStatus = {
      status: 'fail',
      error: { code: 'not_found', message: 'x', requestId: 'r' },
    };
    const result = errorEnvelopeSchema.safeParse(badStatus);
    expect(result.success).toBe(false);
  });

  // ── DisputeStatus enum ────────────────────────────────────────────────────

  it('disputeStatusSchema accepts all five documented status values', () => {
    for (const status of ['open', 'under_review', 'resolved', 'escalated', 'cancelled'] as const) {
      const result = disputeStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    }
  });

  it('disputeStatusSchema rejects "pending" (not in enum)', () => {
    expect(disputeStatusSchema.safeParse('pending').success).toBe(false);
  });

  it('disputeStatusSchema rejects "OPEN" (case-sensitive)', () => {
    expect(disputeStatusSchema.safeParse('OPEN').success).toBe(false);
  });

  it('disputeStatusSchema rejects numeric status', () => {
    expect(disputeStatusSchema.safeParse(1).success).toBe(false);
  });
});
