import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error that is safe to show to the user, with an HTTP status and a stable code. */
export class AppError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class InsufficientTokensError extends AppError {
  constructor() {
    super(402, "insufficient_tokens", "You're out of tokens. Upgrade your plan or wait for your monthly reset.");
  }
}

export class InsufficientAudioSecondsError extends AppError {
  constructor() {
    super(
      402,
      "insufficient_audio_seconds",
      "You have no listening time left. Upgrade your plan or wait for your monthly reset.",
    );
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Please sign in again.") {
    super(401, "unauthorized", message);
  }
}

/**
 * JSON error body. Uses the Anthropic error shape so the desktop app's
 * Anthropic SDK surfaces the message unchanged.
 */
export function errorJson(c: Context, err: AppError) {
  return c.json({ type: "error", error: { type: err.code, message: err.message } }, err.status);
}
