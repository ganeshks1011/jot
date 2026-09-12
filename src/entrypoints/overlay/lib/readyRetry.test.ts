import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READY_MAX_RETRIES, READY_RETRY_INTERVAL_MS, startReadyRetry } from "./readyRetry";

describe("startReadyRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-posts ready until the first init lands", () => {
    const post = vi.fn();
    let received = false;
    startReadyRetry(post, () => received);
    expect(post).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(READY_RETRY_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(1);
    received = true;
    vi.advanceTimersByTime(READY_RETRY_INTERVAL_MS * 5);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("stops after the retry budget when init never arrives", () => {
    const post = vi.fn();
    startReadyRetry(post, () => false);
    vi.advanceTimersByTime(READY_RETRY_INTERVAL_MS * 10);
    expect(post).toHaveBeenCalledTimes(READY_MAX_RETRIES);
  });

  it("cancels pending retries on stop", () => {
    const post = vi.fn();
    const stop = startReadyRetry(post, () => false);
    stop();
    vi.advanceTimersByTime(READY_RETRY_INTERVAL_MS * 5);
    expect(post).not.toHaveBeenCalled();
  });
});
