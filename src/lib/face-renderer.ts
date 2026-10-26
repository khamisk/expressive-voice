/**
 * Original face renderer for the Mood Voice character.
 *
 * The character is a white sphere with two dark squircle eyes. Each eye is
 * laid out on a flat "face sheet", wrapped onto the front of the sphere,
 * turned with the head, then drawn through a gentle perspective camera so
 * features near the viewer read slightly larger and turned eyes foreshorten.
 *
 * Every eye outline has the same number of points in the same order, so
 * expressions, blinks and the smile morph in eye-shapes.ts interpolate
 * smoothly without the outline topology ever changing.
 */

export type EyeMotion = "none" | "microSaccades" | "shake";
export type BodyMotion = "none" | "slowDrift" | "shake";

/** One full face pose. Angles are degrees; sizes are face-sheet units. */
export type Expression = {
  id: string;
  semanticKey?: string;
  /** Pitch: positive looks up. */
  headX: number;
  /** Yaw: positive looks to the viewer's right. */
  headY: number;
  /** Roll: positive tilts clockwise. */
  headZ: number;
  widthLeft: number;
  widthRight: number;
  heightLeft: number;
  heightRight: number;
  /** Distance between the two eye centers. */
  spacing: number;
  positionXLeft: number;
  positionXRight: number;
  positionYLeft: number;
  positionYRight: number;
  leftAngle: number;
  rightAngle: number;
  /** 1 is the standard camera; larger values exaggerate depth. */
  perspective: number;
  eyeMotion: EyeMotion;
  bodyMotion: BodyMotion;
  bodyColor?: string;
  eyeColor?: string;
};

export type ExpressionNumericField = Exclude<
  keyof Expression,
  "id" | "semanticKey" | "bodyColor" | "eyeColor" | "eyeMotion" | "bodyMotion"
>;

export const expressionFields: ExpressionNumericField[] = [
  "headX", "headY", "headZ",
  "widthLeft", "widthRight", "heightLeft", "heightRight",
  "spacing",
  "positionXLeft", "positionXRight", "positionYLeft", "positionYRight",
  "leftAngle", "rightAngle",
  "perspective",
];

type EyeDefinition = { width: number; height: number; x: number; y: number; angle: number };

export type FaceExpressionDefinition = {
  head: { x: number; y: number; z: number };
  eyes: { left: EyeDefinition; right: EyeDefinition; spacing: number };
  perspective: number;
  motion: { eyes: EyeMotion; body: BodyMotion };
  colors?: { body?: string; eyes?: string };
};

export type FaceDefinition = {
  name: string;
  /** Sphere radius in SVG units; the face is drawn around the origin. */
  radius: number;
  colors: { body: string; eyes: string };
  expressions: Record<string, FaceExpressionDefinition>;
  expressionOrder: string[];
};

export type FaceGeometry = {
  headPath: string;
  leftPath: string;
  rightPath: string;
  leftVisible: boolean;
  rightVisible: boolean;
};

export type FaceScene = {
  geometry: FaceGeometry;
  colors: { body: string; eyes: string };
};

/** Points per eye outline. Fixed so every frame morphs point-for-point. */
export const EYE_OUTLINE_POINTS = 72;
/** Squircle exponent: 2 is an ellipse, higher is boxier. */
const EYE_ROUNDNESS = 2.6;
/** Visible lid thickness, in face-sheet units, when the eye is fully shut. */
const CLOSED_EYE_HEIGHT = 7;
/** Camera distance for perspective 1, as a multiple of the sphere radius. */
const CAMERA_DISTANCE = 31 / 6;

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const unit = (value: number) => Math.max(0, Math.min(1, finite(value, 1)));
const fmt = (value: number) => {
  const fixed = value.toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed;
};

export const expressionFromDefinition = (key: string, definition: FaceExpressionDefinition): Expression => ({
  id: key,
  semanticKey: key,
  headX: definition.head.x,
  headY: definition.head.y,
  headZ: definition.head.z,
  widthLeft: definition.eyes.left.width,
  widthRight: definition.eyes.right.width,
  heightLeft: definition.eyes.left.height,
  heightRight: definition.eyes.right.height,
  spacing: definition.eyes.spacing,
  positionXLeft: definition.eyes.left.x,
  positionXRight: definition.eyes.right.x,
  positionYLeft: definition.eyes.left.y,
  positionYRight: definition.eyes.right.y,
  leftAngle: definition.eyes.left.angle,
  rightAngle: definition.eyes.right.angle,
  perspective: definition.perspective,
  eyeMotion: definition.motion.eyes,
  bodyMotion: definition.motion.body,
  ...(definition.colors?.body ? { bodyColor: definition.colors.body } : {}),
  ...(definition.colors?.eyes ? { eyeColor: definition.colors.eyes } : {}),
});

type Vec3 = [number, number, number];

/** Head orientation as a 3x3 rotation (pitch, then yaw, then roll). */
function headRotation(pitch: number, yaw: number, roll: number) {
  const [sx, cx] = [Math.sin(radians(pitch)), Math.cos(radians(pitch))];
  const [sy, cy] = [Math.sin(radians(yaw)), Math.cos(radians(yaw))];
  const [sz, cz] = [Math.sin(radians(roll)), Math.cos(radians(roll))];
  return ([x, y, z]: Vec3): Vec3 => {
    // Pitch about the horizontal axis. Screen y points down, so looking up
    // lifts the front of the face toward negative y.
    const y1 = y * cx - z * sx;
    const z1 = y * sx + z * cx;
    // Yaw about the vertical axis: looking right carries the front toward +x.
    const x2 = x * cy + z1 * sy;
    const z2 = -x * sy + z1 * cy;
    // Roll in the picture plane.
    return [x2 * cz - y1 * sz, x2 * sz + y1 * cz, z2];
  };
}

class FaceCamera {
  private readonly distance: number;

  constructor(private readonly radius: number, perspective: number) {
    // Stronger perspective means a closer camera. Clamp so a bad value can
    // never put the camera inside the sphere.
    const strength = Math.max(0.25, Math.min(4, finite(perspective, 1)));
    this.distance = Math.max(radius * 1.5, (radius * CAMERA_DISTANCE) / strength);
  }

  /** Wrap a face-sheet point onto the front of the sphere. */
  wrap(u: number, v: number): Vec3 {
    const longitude = u / this.radius;
    const latitude = v / this.radius;
    return [
      this.radius * Math.sin(longitude) * Math.cos(latitude),
      this.radius * Math.sin(latitude),
      this.radius * Math.cos(longitude) * Math.cos(latitude),
    ];
  }

  project([x, y, z]: Vec3): [number, number] {
    const scale = this.distance / (this.distance - z);
    return [x * scale, y * scale];
  }

  /** Apparent radius of the sphere's outline seen from this camera. */
  silhouetteRadius(): number {
    const d = this.distance;
    return (this.radius * d) / Math.sqrt(d * d - this.radius * this.radius);
  }
}

type EyeLayout = { centerU: number; centerV: number; width: number; height: number; angle: number };

/** Squircle outline in face-sheet units, starting at the top and going clockwise. */
function eyeOutline({ centerU, centerV, width, height, angle }: EyeLayout): Array<[number, number]> {
  const a = Math.max(0.5, width / 2);
  const b = Math.max(0.5, height / 2);
  const exponent = 2 / EYE_ROUNDNESS;
  const [s, c] = [Math.sin(radians(angle)), Math.cos(radians(angle))];
  const points: Array<[number, number]> = [];
  for (let i = 0; i < EYE_OUTLINE_POINTS; i++) {
    const t = (i / EYE_OUTLINE_POINTS) * Math.PI * 2;
    const ct = Math.sin(t);
    const st = -Math.cos(t);
    const x = a * Math.sign(ct) * Math.abs(ct) ** exponent;
    const y = b * Math.sign(st) * Math.abs(st) ** exponent;
    points.push([centerU + x * c - y * s, centerV + x * s + y * c]);
  }
  return points;
}

function eyeLayouts(expression: Expression, openness: number): [EyeLayout, EyeLayout] {
  const open = unit(openness);
  const lidHeight = (height: number) => {
    const full = Math.max(0, finite(height));
    const closed = Math.min(full, CLOSED_EYE_HEIGHT);
    return closed + (full - closed) * open;
  };
  const half = finite(expression.spacing) / 2;
  return [
    {
      centerU: -half + finite(expression.positionXLeft),
      centerV: finite(expression.positionYLeft),
      width: Math.max(0, finite(expression.widthLeft)),
      height: lidHeight(expression.heightLeft),
      angle: finite(expression.leftAngle),
    },
    {
      centerU: half + finite(expression.positionXRight),
      centerV: finite(expression.positionYRight),
      width: Math.max(0, finite(expression.widthRight)),
      height: lidHeight(expression.heightRight),
      angle: finite(expression.rightAngle),
    },
  ];
}

function circlePath(radius: number): string {
  const r = fmt(radius);
  return `M${r} 0.00A${r} ${r} 0 1 1 -${r} 0.00A${r} ${r} 0 1 1 ${r} 0.00Z`;
}

export function renderFace(radius: number, expression: Expression, openness = 1): FaceGeometry {
  const camera = new FaceCamera(radius, expression.perspective);
  const turn = headRotation(finite(expression.headX), finite(expression.headY), finite(expression.headZ));
  const [left, right] = eyeLayouts(expression, openness);

  const drawEye = (layout: EyeLayout) => {
    const center = turn(camera.wrap(layout.centerU, layout.centerV));
    const outline = eyeOutline(layout).map(([u, v]) => camera.project(turn(camera.wrap(u, v))));
    const path = outline.map(([x, y], index) => `${index === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`).join("") + "Z";
    return { path, visible: center[2] > 0 };
  };

  const leftEye = drawEye(left);
  const rightEye = drawEye(right);
  return {
    headPath: circlePath(camera.silhouetteRadius()),
    leftPath: leftEye.path,
    rightPath: rightEye.path,
    leftVisible: leftEye.visible,
    rightVisible: rightEye.visible,
  };
}

export const renderAvatarExpression = (
  definition: Readonly<FaceDefinition>,
  expression: Expression,
  colors: { body?: string; eyes?: string } = {},
  openness = 1,
): FaceScene => ({
  geometry: renderFace(definition.radius, expression, openness),
  colors: {
    body: colors.body ?? expression.bodyColor ?? definition.colors.body,
    eyes: colors.eyes ?? expression.eyeColor ?? definition.colors.eyes,
  },
});

export type FaceValidation = { ok: true; value: FaceDefinition } | { ok: false; errors: string[] };

export function validateFaceDefinition(definition: FaceDefinition): FaceValidation {
  const errors: string[] = [];
  const number = (value: unknown, path: string) => {
    if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path} must be a finite number`);
  };
  number(definition.radius, "radius");
  if (!(definition.radius > 0)) errors.push("radius must be positive");
  for (const [key, expression] of Object.entries(definition.expressions)) {
    for (const axis of ["x", "y", "z"] as const) number(expression.head[axis], `${key}.head.${axis}`);
    for (const side of ["left", "right"] as const) {
      for (const field of ["width", "height", "x", "y", "angle"] as const) {
        number(expression.eyes[side][field], `${key}.eyes.${side}.${field}`);
      }
    }
    number(expression.eyes.spacing, `${key}.eyes.spacing`);
    number(expression.perspective, `${key}.perspective`);
  }
  for (const key of definition.expressionOrder) {
    if (!(key in definition.expressions)) errors.push(`expressionOrder lists unknown expression "${key}"`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: definition };
}
