import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFrameLoop } from "./frame-loop";

describe("live frame scheduling", () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let id: number;

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = new Map();
    id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps live facial and audio state moving when the browser throttles RAF", () => {
    const paint = vi.fn();
    const stop = startFrameLoop(paint);
    // Intentionally never fire any RAF callback, simulating the preview stall.
    vi.advanceTimersByTime(320);
    expect(paint).toHaveBeenCalledTimes(10);
    expect(callbacks.size).toBe(1);
    stop();
    expect(callbacks.size).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(paint).toHaveBeenCalledTimes(10);
  });

  it("uses normal display frames without double-firing the watchdog", () => {
    const paint = vi.fn();
    const stop = startFrameLoop(paint);
    vi.advanceTimersByTime(16);
    [...callbacks.values()][0](16);
    expect(paint).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(16);
    expect(paint).toHaveBeenCalledTimes(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
