const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function outlineBounds(path: string) {
  const points = [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)];
  if (!points.length) return null;
  const xs = points.map(point => Number(point[1]));
  const ys = points.map(point => Number(point[2]));
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
}

/**
 * Bend the existing outline into a chunky happy crescent. Compressing its
 * thickness as the arch rises opens the underside; translating every point
 * by a parabola alone made the old smiles read as bent blobs. Same vertices,
 * same order, continuous deformation even through a blink or interruption.
 */
export function smileEyePath(path: string, smile: number): string {
  const requested = unit(smile);
  if (requested === 0) return path;
  const bounds = outlineBounds(path);
  if (!bounds) return path;
  // In a wink, keep the tall open eye a friendly capsule. Curving/compressing
  // that eye like its short partner creates an accidental flat-bottom arch.
  const suitability = unit((1.7 - bounds.height / Math.max(1, bounds.width)) / 0.6);
  const amount = requested * suitability * suitability * (3 - 2 * suitability);
  if (amount === 0) return path;
  const radius = Math.max(1, bounds.width / 2);
  const eased = amount * (2 - amount);
  // A blink must still close. Tie curve lift to the visible eye height so
  // neither the arch nor its thickness can survive as a frozen open eye.
  const lift = Math.min(bounds.width * 0.43, bounds.height * 0.86) * eased;
  const thickness = 1 - 0.7 * eased;
  return path.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_match, command: string, x: string, y: string) => {
    const u = (Number(x) - bounds.x) / radius;
    const arch = 1 - u * u;
    const nextY = bounds.y + (Number(y) - bounds.y) * thickness - arch * lift;
    return `${command}${x} ${nextY.toFixed(2)}`;
  });
}
