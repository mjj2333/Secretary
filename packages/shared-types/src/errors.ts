export class SecretaryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends SecretaryError {
  constructor(message: string) {
    super('validation_error', message, 400);
  }
}

export class AuthError extends SecretaryError {
  constructor(message = 'Unauthorized') {
    super('unauthorized', message, 401);
  }
}

export class ForbiddenError extends SecretaryError {
  constructor(message = 'Forbidden') {
    super('forbidden', message, 403);
  }
}

export class NotFoundError extends SecretaryError {
  constructor(message = 'Not found') {
    super('not_found', message, 404);
  }
}

export class RateLimitError extends SecretaryError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = 'Rate limit exceeded') {
    super('rate_limited', message, 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class DecryptionError extends SecretaryError {
  constructor(message = 'Payload decryption failed') {
    super('decryption_failed', message, 400);
  }
}

export class UpstreamError extends SecretaryError {
  constructor(code: string, message: string, status = 502) {
    super(code, message, status);
  }
}

export class ImapError extends SecretaryError {
  constructor(message = 'IMAP connection failed') {
    super('imap_connection_failed', message, 400);
  }
}
