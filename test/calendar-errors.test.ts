import { describe, expect, it } from "vitest";
import { toCalendarError } from "../src/calendar/google-errors";
import { AuthRevoked, EventConflict, EventGone, PermissionDenied, ProviderUnavailable } from "../src/calendar/model";
import { GoogleApiError, GoogleAuthError } from "../src/google/errors";

describe("toCalendarError (tech-debt #12)", () => {
  it.each([
    [404, EventGone],
    [410, EventGone],
    [412, EventConflict],
    [403, PermissionDenied],
    [429, ProviderUnavailable],
    [500, ProviderUnavailable],
    [503, ProviderUnavailable],
  ] as const)("Calendar API %i", (status, cls) => {
    expect(toCalendarError(new GoogleApiError(`failed: ${status}`, status))).toBeInstanceOf(cls);
  });

  it("403 with a rate-limit reason is unavailability, not missing permission", () => {
    const e = new GoogleApiError('events.list failed: 403 {"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', 403);
    expect(toCalendarError(e)).toBeInstanceOf(ProviderUnavailable);
  });

  it("token refresh: invalid_grant → revoked, otherwise unavailable", () => {
    expect(toCalendarError(new GoogleAuthError("invalid_grant", true))).toBeInstanceOf(AuthRevoked);
    expect(toCalendarError(new GoogleAuthError("500", false))).toBeInstanceOf(ProviderUnavailable);
  });

  it("timeouts and network failures", () => {
    expect(toCalendarError(new DOMException("timed out", "TimeoutError"))).toBeInstanceOf(ProviderUnavailable);
    expect(toCalendarError(new TypeError("fetch failed"))).toBeInstanceOf(ProviderUnavailable);
  });

  it("other errors pass through unchanged", () => {
    const bug = new TypeError("cannot read properties of undefined");
    expect(toCalendarError(bug)).toBe(bug);
    const gone = new EventGone("x");
    expect(toCalendarError(gone)).toBe(gone);
  });
});
