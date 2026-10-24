/**
 * Prefer display-synchronised frames, but don't let an embedded/background
 * WebView's 1 Hz RAF throttle freeze live audio metering and facial state.
 */
export function startFrameLoop(onFrame: (time: number) => void): () => void {
  let frame = 0;
  let fallback: ReturnType<typeof setTimeout>;
  let stopped = false;

  const tick = () => {
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    if (stopped) return;
    onFrame(performance.now());
    if (stopped) return;
    frame = requestAnimationFrame(tick);
    fallback = setTimeout(tick, 32);
  };

  frame = requestAnimationFrame(tick);
  fallback = setTimeout(tick, 32);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
  };
}
