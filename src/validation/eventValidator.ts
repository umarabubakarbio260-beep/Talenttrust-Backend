/**
 * @module validation/eventValidator
 * @description Validation utilities for ContractEvent payloads.
 *
 * Provides:
 *  - `EventValidator.validate` — base field validation for any ContractEvent.
 *  - `EventValidator.validateContractSpecificEvent` — contract-type-specific payload rules.
 *  - `EventValidator.validatePayload` — validation against an arbitrary Joi schema.
 */

import { ContractEvent } from '../events/types';

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

/** Valid actions for talent_contract events */
const TALENT_CONTRACT_ACTIONS = ['created', 'updated', 'deleted', 'activated', 'deactivated'] as const;

/** Valid statuses for payment_contract events */
const PAYMENT_CONTRACT_STATUSES = ['pending', 'completed', 'failed', 'refunded', 'cancelled'] as const;

/**
 * A minimal Joi-compatible schema interface used by validatePayload.
 * The real Joi schema object satisfies this shape at runtime.
 */
interface JoiLikeSchema {
  validate(value: unknown, options?: Record<string, unknown>): {
    error?: { details: Array<{ message: string; path: string[] }> };
  };
}

export class EventValidator {
  /**
   * Validate the base fields of a ContractEvent.
   *
   * Checks:
   * - `contractId` — must be a non-empty string
   * - `eventId`    — must be a non-empty string
   * - `sequence`   — must be a non-negative integer
   * - `timestamp`  — must be a finite number
   * - `payload`    — must be a non-null object
   */
  static validate(event: Partial<ContractEvent>): ValidationResult {
    const errors: ValidationError[] = [];

    // contractId
    if (event.contractId === undefined || event.contractId === null) {
      errors.push({ field: 'contractId', message: 'contractId is required' });
    } else if (typeof event.contractId !== 'string' || event.contractId.trim().length === 0) {
      errors.push({ field: 'contractId', message: 'contractId must be a non-empty string' });
    }

    // eventId
    if (event.eventId === undefined || event.eventId === null) {
      errors.push({ field: 'eventId', message: 'eventId is required' });
    } else if (typeof event.eventId !== 'string' || event.eventId.trim().length === 0) {
      errors.push({ field: 'eventId', message: 'eventId must be a non-empty string' });
    }

    // sequence
    if (event.sequence === undefined || event.sequence === null) {
      errors.push({ field: 'sequence', message: 'sequence is required' });
    } else if (typeof event.sequence !== 'number' || !Number.isInteger(event.sequence)) {
      errors.push({ field: 'sequence', message: 'sequence must be an integer' });
    } else if (event.sequence < 0) {
      errors.push({ field: 'sequence', message: 'sequence must be a non-negative integer' });
    }

    // timestamp
    if (event.timestamp === undefined || event.timestamp === null) {
      errors.push({ field: 'timestamp', message: 'timestamp is required' });
    } else if (typeof event.timestamp !== 'number' || !isFinite(event.timestamp)) {
      errors.push({ field: 'timestamp', message: 'timestamp must be a finite number' });
    }

    // payload
    if (event.payload === undefined || event.payload === null) {
      errors.push({ field: 'payload', message: 'payload is required' });
    } else if (typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      errors.push({ field: 'payload', message: 'payload must be a non-null object' });
    }

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Validate contract-type-specific payload constraints.
   *
   * Supported contract types:
   * - `talent_contract`  — requires `payload.talentId` and a valid `payload.action`
   * - `payment_contract` — requires `payload.paymentId`, non-negative `payload.amount`,
   *                        `payload.currency`, valid `payload.status`, and `payload.timestamp`
   * - `review_contract`  — requires `payload.reviewId`, `payload.reviewerId`,
   *                        `payload.rating` (1–5), and `payload.createdAt`
   *
   * Unknown contract types return a single error on the `contractId` field.
   */
  static validateContractSpecificEvent(
    event: Partial<ContractEvent>,
    contractType: string,
  ): ValidationResult {
    const errors: ValidationError[] = [];
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    switch (contractType) {
      case 'talent_contract': {
        if (!payload.talentId || typeof payload.talentId !== 'string') {
          errors.push({ field: 'payload.talentId', message: 'payload.talentId is required' });
        }
        if (
          payload.action === undefined ||
          !(TALENT_CONTRACT_ACTIONS as readonly string[]).includes(payload.action as string)
        ) {
          errors.push({
            field: 'payload.action',
            message: `payload.action must be one of: ${TALENT_CONTRACT_ACTIONS.join(', ')}`,
          });
        }
        break;
      }

      case 'payment_contract': {
        if (!payload.paymentId || typeof payload.paymentId !== 'string') {
          errors.push({ field: 'payload.paymentId', message: 'payload.paymentId is required' });
        }
        if (typeof payload.amount !== 'number' || payload.amount < 0) {
          errors.push({ field: 'payload.amount', message: 'payload.amount must be a non-negative number' });
        }
        if (!payload.currency || typeof payload.currency !== 'string') {
          errors.push({ field: 'payload.currency', message: 'payload.currency is required' });
        }
        if (
          payload.status === undefined ||
          !(PAYMENT_CONTRACT_STATUSES as readonly string[]).includes(payload.status as string)
        ) {
          errors.push({
            field: 'payload.status',
            message: `payload.status must be one of: ${PAYMENT_CONTRACT_STATUSES.join(', ')}`,
          });
        }
        if (payload.timestamp === undefined || typeof payload.timestamp !== 'number') {
          errors.push({ field: 'payload.timestamp', message: 'payload.timestamp is required' });
        }
        break;
      }

      case 'review_contract': {
        if (!payload.reviewId || typeof payload.reviewId !== 'string') {
          errors.push({ field: 'payload.reviewId', message: 'payload.reviewId is required' });
        }
        if (!payload.reviewerId || typeof payload.reviewerId !== 'string') {
          errors.push({ field: 'payload.reviewerId', message: 'payload.reviewerId is required' });
        }
        if (
          typeof payload.rating !== 'number' ||
          !Number.isInteger(payload.rating) ||
          payload.rating < 1 ||
          payload.rating > 5
        ) {
          errors.push({ field: 'payload.rating', message: 'payload.rating must be an integer between 1 and 5' });
        }
        if (payload.createdAt === undefined) {
          errors.push({ field: 'payload.createdAt', message: 'payload.createdAt is required' });
        }
        break;
      }

      default: {
        errors.push({
          field: 'contractId',
          message: `Unknown contract type: ${contractType}`,
        });
        break;
      }
    }

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Validate an arbitrary payload against a Joi-compatible schema.
   *
   * @param payload - The data to validate.
   * @param schema  - A Joi schema (or any object with a compatible `.validate()` method).
   */
  static validatePayload(payload: unknown, schema: JoiLikeSchema): ValidationResult {
    const { error } = schema.validate(payload, { abortEarly: false });

    if (!error) {
      return { isValid: true, errors: [] };
    }

    const errors: ValidationError[] = error.details.map((detail) => ({
      field: detail.path.join('.') || 'unknown',
      message: detail.message,
    }));

    return { isValid: false, errors };
  }
}
