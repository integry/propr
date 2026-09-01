export const MIN_WEBHOOK_SECRET_LENGTH = 16;
export const MAX_WEBHOOK_SECRET_LENGTH = 512;

/** Shared main-process policy for webhook secrets acquired and held by setup. */
export const isValidWebhookSecret = (value: string): boolean =>
  value.length >= MIN_WEBHOOK_SECRET_LENGTH
  && value.length <= MAX_WEBHOOK_SECRET_LENGTH
  && !/[\0\r\n]/.test(value);
