// src/errors.ts

/**
 * خطأ عدم وجود الحساب عند محاولة القفل أو التحقق منه داخل العمليات والمعاملات
 */
export class AccountNotFoundError extends Error {
  constructor(message = 'Account not found') {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}
