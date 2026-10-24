import { describe, expect, it } from "vitest";
import { LocalTurnDetector, type LocalTurnDetectorState } from "./local-turn-detector";

function run(
  detector: LocalTurnDetector,
  from: number,
  to: number,
  step: number,
  rms: number,
): LocalTurnDetectorState[] {
  const states: LocalTurnDetectorState[] = [];
  for (let now = from; now <= to; now += step) {
    states.push(detector.update({ nowMs: now, rms }));
  }
  return states;
}

function startQuietVoice(detector: LocalTurnDetector, startAt = 100): LocalTurnDetectorState[] {
  detector.update({ nowMs: 0, rms: 0 });
  return run(detector, startAt, startAt + 96, 16, 0.01);
}

describe("LocalTurnDetector", () => {
  it("stays idle on silence and learns a bounded idle noise floor", () => {
    const detector = new LocalTurnDetector();
    const states = run(detector, 0, 3_000, 16, 0.004);
    const last = states.at(-1) as LocalTurnDetectorState;

    expect(last.active).toBe(false);
    expect(states.some((state) => state.started || state.stopped)).toBe(false);
    expect(last.noiseFloor).toBeGreaterThan(0.0025);
    expect(last.noiseFloor).toBeLessThanOrEqual(0.08);
    expect(last.reason).toBe("none");
  });

  it("calibrates a steady microphone floor without emitting turns", () => {
    const detector = new LocalTurnDetector();
    const calibrationStates: LocalTurnDetectorState[] = [];
    for (let now = 0; now <= 2_000; now += 16) {
      calibrationStates.push(detector.calibrate({ nowMs: now, rms: 0.008 }));
    }

    expect(calibrationStates.every((state) => (
      state.started === false && state.stopped === false && state.active === false
    ))).toBe(true);
    const calibratedFloor = calibrationStates.at(-1)?.noiseFloor ?? 0;
    expect(calibratedFloor).toBeGreaterThan(0.0036);

    detector.reset(2_000, true);
    const sameNoise = run(detector, 2_016, 3_200, 16, 0.008);
    expect(sameNoise.some((state) => state.started || state.stopped)).toBe(false);

    const speech = run(detector, 3_216, 3_360, 16, 0.03);
    expect(speech.filter((state) => state.started)).toHaveLength(1);
  });

  it("keeps one calibration outlier from materially raising the speech gate", () => {
    const detector = new LocalTurnDetector();
    for (let now = 0; now <= 1_000; now += 16) {
      detector.calibrate({ nowMs: now, rms: 0.004 });
    }
    const beforeOutlier = detector.calibrate({ nowMs: 1_016, rms: 0.2 }).noiseFloor;
    for (let now = 1_032; now <= 2_000; now += 16) {
      detector.calibrate({ nowMs: now, rms: 0.004 });
    }

    const afterOutlier = detector.calibrate({ nowMs: 2_016, rms: 0.004 }).noiseFloor;
    expect(afterOutlier).toBeLessThan(0.005);
    expect(afterOutlier - beforeOutlier).toBeLessThan(0.001);

    detector.reset(2_016, true);
    const quietAfterCalibration = run(detector, 2_032, 3_200, 16, 0.008);
    expect(quietAfterCalibration.some((state) => state.started)).toBe(false);
  });

  it("does not turn a single click or separated peaks into speech", () => {
    const detector = new LocalTurnDetector();
    const states = [
      detector.update({ nowMs: 0, rms: 0 }),
      detector.update({ nowMs: 16, rms: 0.2 }),
      detector.update({ nowMs: 32, rms: 0 }),
      detector.update({ nowMs: 48, rms: 0.18 }),
      detector.update({ nowMs: 64, rms: 0 }),
      detector.update({ nowMs: 300, rms: 0.2 }),
      detector.update({ nowMs: 316, rms: 0 }),
    ];

    expect(states.some((state) => state.started)).toBe(false);
    expect(states.every((state) => state.active === false)).toBe(true);
  });

  it("recognizes a quiet voice after a short confirmation attack", () => {
    const detector = new LocalTurnDetector();
    const states = startQuietVoice(detector);
    const starts = states.filter((state) => state.started);

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ active: true, reason: "speech", rms: 0.01 });
    expect(starts[0].speechMs).toBe(0);
  });

  it("holds through a short internal pause and stops only after trailing silence", () => {
    const detector = new LocalTurnDetector();
    const started = startQuietVoice(detector);
    expect(started.at(-1)?.active).toBe(true);

    // 0.005 is below the start gate for this fixture but above the lower
    // hysteresis gate, so this is a quiet syllable gap rather than silence.
    const internalPause = run(detector, 212, 500, 16, 0.005);
    expect(internalPause.some((state) => state.stopped)).toBe(false);
    expect(internalPause.at(-1)?.active).toBe(true);
    expect(internalPause.at(-1)?.silenceMs).toBe(0);

    const resumed = run(detector, 516, 612, 16, 0.016);
    expect(resumed.some((state) => state.stopped)).toBe(false);
    expect(resumed.at(-1)?.active).toBe(true);

    const trailing = run(detector, 628, 1_260, 16, 0);
    const stops = trailing.filter((state) => state.stopped);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ active: false, reason: "silence" });
    expect(stops[0].silenceMs).toBeGreaterThanOrEqual(580);
    expect(detector.active).toBe(false);
  });

  it("requires a consecutive candidate after a long sampling gap", () => {
    const detector = new LocalTurnDetector();
    detector.update({ nowMs: 0, rms: 0 });
    detector.update({ nowMs: 16, rms: 0.02 });
    const afterGap = detector.update({ nowMs: 316, rms: 0.02 });
    expect(afterGap.started).toBe(false);
    expect(afterGap.active).toBe(false);

    const next = detector.update({ nowMs: 396, rms: 0.02 });
    expect(next.started).toBe(true);
    expect(next.active).toBe(true);
  });

  it("emits a finite max-duration stop and requires a quiet re-arm", () => {
    const detector = new LocalTurnDetector({
      attackMs: 60,
      releaseMs: 200,
      maxUtteranceMs: 300,
    });
    const starts = startQuietVoice(detector, 100);
    expect(starts.some((state) => state.started)).toBe(true);

    const maxStates = run(detector, 212, 612, 16, 0.03);
    const maxStops = maxStates.filter((state) => state.stopped);
    expect(maxStops).toHaveLength(1);
    expect(maxStops[0]).toMatchObject({ active: false, reason: "max_duration" });
    expect(maxStops[0].elapsedMs).toBe(300);

    const hotAgain = detector.update({ nowMs: 628, rms: 0.03 });
    expect(hotAgain.started).toBe(false);
    expect(hotAgain.active).toBe(false);
    detector.update({ nowMs: 644, rms: 0 });
    const restarted = run(detector, 660, 740, 16, 0.03);
    expect(restarted.some((state) => state.started)).toBe(true);
  });

  it("allows a continuous conversation past thirty seconds when the cap is disabled", () => {
    const detector = new LocalTurnDetector({ maxUtteranceMs: null, releaseMs: 220 });
    const starts = startQuietVoice(detector, 100);
    expect(starts.some((state) => state.started)).toBe(true);

    const continuous = run(detector, 212, 30_612, 16, 0.03);
    expect(continuous.some((state) => state.stopped)).toBe(false);
    expect(continuous.at(-1)?.active).toBe(true);
    expect(continuous.at(-1)?.elapsedMs).toBeGreaterThan(30_000);

    const pause = run(detector, 30_628, 31_100, 16, 0);
    const stops = pause.filter((state) => state.stopped);
    expect(stops).toHaveLength(1);
    expect(stops[0].reason).toBe("silence");
  });

  it("reports one stop when detection is disabled and starts cleanly when re-enabled", () => {
    const detector = new LocalTurnDetector();
    const states = startQuietVoice(detector);
    expect(states.at(-1)?.active).toBe(true);

    const disabled = detector.update({ nowMs: 212, rms: 0.02, enabled: false });
    expect(disabled).toMatchObject({ started: false, stopped: true, active: false, reason: "disabled" });
    const stillDisabled = detector.update({ nowMs: 228, rms: 0.02 });
    expect(stillDisabled).toMatchObject({ started: false, stopped: false, active: false, reason: "none" });

    const reenabled: LocalTurnDetectorState[] = [
      detector.update({ nowMs: 244, rms: 0.01, enabled: true }),
      ...run(detector, 260, 340, 16, 0.01),
    ];
    expect(reenabled.filter((state) => state.started)).toHaveLength(1);
    expect(reenabled.at(-1)?.active).toBe(true);
  });

  it("reset clears a pending candidate, active turn, and learned floor", () => {
    const detector = new LocalTurnDetector();
    startQuietVoice(detector);
    expect(detector.active).toBe(true);

    detector.reset(5_000);
    const afterReset = detector.update({ nowMs: 4_000, rms: 0 });
    expect(afterReset).toMatchObject({ started: false, stopped: false, active: false, elapsedMs: 0 });
    expect(afterReset.noiseFloor).toBe(0.0025);
    expect(detector.active).toBe(false);
  });

  it("never produces negative or non-finite state for invalid amplitudes and clock corrections", () => {
    const detector = new LocalTurnDetector();
    const states = [
      detector.update({ nowMs: -100, rms: Number.NaN }),
      detector.update({ nowMs: 100, rms: 0.02 }),
      detector.update({ nowMs: 50, rms: Number.POSITIVE_INFINITY }),
      detector.update({ nowMs: Number.NaN, rms: Number.NEGATIVE_INFINITY }),
      detector.update({ nowMs: 300, rms: 0.02 }),
    ];

    for (const state of states) {
      expect(state.rms).toBeGreaterThanOrEqual(0);
      expect(state.noiseFloor).toBeGreaterThanOrEqual(0);
      expect(state.speechMs).toBeGreaterThanOrEqual(0);
      expect(state.silenceMs).toBeGreaterThanOrEqual(0);
      expect(state.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(state.rms)).toBe(true);
      expect(Number.isFinite(state.noiseFloor)).toBe(true);
      expect(Number.isFinite(state.speechMs)).toBe(true);
      expect(Number.isFinite(state.silenceMs)).toBe(true);
      expect(Number.isFinite(state.elapsedMs)).toBe(true);
    }
  });
});
