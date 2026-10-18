export class DotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DotError';
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}
