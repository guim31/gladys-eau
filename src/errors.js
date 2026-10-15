// -----------------------------------------------------------------------------
// The errors of the sign-in and of the distributors' APIs.
//
// The cycle decides what to do from the class alone: a refused password is
// not retried before the user changes the configuration, anything else is a
// transient failure retried within the hour. Messages never carry a
// credential, a token or a URL query: they end up in the logs and in the
// Gladys interface.
// -----------------------------------------------------------------------------

/** The distributor refused the email or the password. */
export class InvalidAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAuthError';
  }
}

/** A network error, a server error or a page that changed: retried later. */
export class CannotConnectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CannotConnectError';
  }
}

/** An HTTP answer outside 2xx. `url` carries no query string. */
export class HttpError extends Error {
  constructor(status, url, body = '') {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    // Kept for the parsers (an error body explains a refusal), never logged.
    this.body = body;
  }
}
