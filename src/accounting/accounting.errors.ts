export const REFUSAL_CODES = [
  'INSUFFICIENT_CREDIT',
  'EMPTY_CAMPAIGN',
  'DUPLICATE_RECIPIENT',
  'RECIPIENT_NOT_FOUND',
  'CAMPAIGN_NOT_EDITABLE',
  'SCHEDULE_CONFLICT',
  'ORDER_NOT_FOUND',
  'ORDER_CONFLICT',
  'INVALID_QUANTITY',
  'CAMPAIGN_NOT_FOUND',
  'CAMPAIGN_CONFLICT',
  'MESSAGE_NOT_FOUND',
  'HANDOFF_CONFLICT',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export class AccountingError extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = 'AccountingError';
    this.code = code;
  }
}
