// src/errors.ts

/**
 * Thrown when an account record is not found during operations or transactional locking
 */
export class AccountNotFoundError extends Error {
  constructor(message = 'Account not found') {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}
