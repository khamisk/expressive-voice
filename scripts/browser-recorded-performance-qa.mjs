/**
 * Inspect existing recorded character studies through the approved Browser tab.
 * No provider calls, hidden app state, microphone access, or browser launch.
 * This measures rendered choreography, not human listening or word-exact sync.
 */
export async function captureRecordedFrame(tab) {
  return tab.playwright.evaluate(() => {
    const actor = document.querySelector('[data-performance]');
    const audio = document.querySelector('audio');
    const bounds = (selector) => {
      const path = document.querySelector(selector)?.getAttribute('d') || '';
      const points = [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)]
        .map(match => [Number(match[1]), Number(match[2])]);
      if (!points.length) return null;
      const xs = points.map(point => point[0]);
      const ys = points.map(point => point[1]);
      return { x: Math.min(...xs), y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    };
    return {
      time: audio?.currentTime ?? 0,
      paused: audio?.paused ?? true,
      expression: actor?.getAttribute('data-expression'),
      cue: actor?.getAttribute('data-cue-id'),
      variant: actor?.getAttribute('data-variant-id'),
      word: actor?.getAttribute('data-word-tick'),
      phrase: actor?.getAttribute('data-phrase-tick'),
      gesture: actor?.getAttribute('data-gesture'),
      accent: actor?.getAttribute('data-accent'),
      head: actor?.getAttribute('data-head-pose'),
      body: actor?.getAttribute('data-body-pose'),
      effect: actor?.getAttribute('data-effect'),
      visibleParticles: [...document.querySelectorAll('[data-reaction-effects] path')]
        .filter(path => Number(path.getAttribute('opacity') || 0) > 0.01).length,
      caption: document.querySelector('[data-caption-window]')?.textContent || '',
      left: bounds('[data-eye="left"]'),
      right: bounds('[data-eye="right"]'),
      error: document.querySelector('[role="alert"]')?.textContent || null,
    };
  });
}

export function summarizeRecordedFrames(frames) {
  const cues = [];
  for (const frame of frames) {
    const previous = cues.at(-1);
    if (!previous || previous.cue !== frame.cue) {
      cues.push({ cue: frame.cue, expression: frame.expression,
        start: frame.time, end: frame.time, variants: [frame.variant] });
    } else {
      previous.end = frame.time;
      if (!previous.variants.includes(frame.variant)) previous.variants.push(frame.variant);
    }
  }
  return {
    sampleCount: frames.length,
    durationSeconds: frames.at(-1)?.time ?? 0,
    completed: frames.some(frame => !frame.paused) && frames.at(-1)?.paused === true,
    cues,
    effects: [...new Set(frames.map(frame => frame.effect).filter(effect => effect && effect !== 'none'))],
    maxVisibleParticles: Math.max(0, ...frames.map(frame => frame.visibleParticles ?? 0)),
    maxHeadDegrees: Math.max(0, ...frames.flatMap(frame => (frame.head || '').split(',').map(value => Math.abs(Number(value) || 0)))),
    minVisibleEyeHeight: Math.min(Infinity, ...frames.flatMap(frame => [frame.left?.height, frame.right?.height]).filter(value => Number.isFinite(value) && value > 3)),
    error: frames.find(frame => frame.error)?.error ?? null,
  };
}

export async function runRecordedPerformance(tab, buttonName, options = {}) {
  const frames = [];
  const startedAt = new Date().toISOString();
  await tab.playwright.getByRole('button', { name: buttonName, exact: true }).click();
  const start = Date.now();
  let played = false;
  while (Date.now() - start < Math.min(15_000, options.timeoutMs ?? 11_000)) {
    const frame = await captureRecordedFrame(tab);
    frame.sampledAfterMs = Date.now() - start;
    frames.push(frame);
    played ||= !frame.paused;
    if (options.onFrame) await options.onFrame(frame);
    if (frame.error || (played && frame.paused)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const summary = summarizeRecordedFrames(frames);
  if (!summary.completed && !summary.error) {
    await tab.playwright.getByRole('button', { name: 'Stop playback', exact: true }).click();
  }
  return { kind: 'recorded-browser-choreography', startedAt, buttonName, summary, frames };
}
