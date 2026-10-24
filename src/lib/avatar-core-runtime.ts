import {
  expressionFields,
  poseFromExpression,
  renderAvatar,
} from "@bible-strong/avatar-core/geometry";
import type {
  AvatarBodyDefinition,
  AvatarDefinition,
  AvatarExpressionDefinition,
} from "@bible-strong/avatar-core";
import type { AvatarBody } from "@bible-strong/avatar-core/body";
import type { Expression } from "@bible-strong/avatar-core/geometry";

export { expressionFields };

export const expressionFromDefinition = (
  key: string,
  definition: AvatarExpressionDefinition,
): Expression => ({
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

/**
 * Browser-safe subset of avatar-core's scene renderer.
 *
 * The published root entry also initializes its JSON-schema validator at
 * module load time. The SHERPA embed only needs the renderer, so this keeps
 * the exact scene calculation on the package's geometry modules without
 * loading the validator into the standalone browser bundle.
 */
const bodyFromDefinition = (body: AvatarBodyDefinition): AvatarBody => ({
  primary: { ...body.primary },
  nodes: body.nodes.map((node, index) => ({
    id: `runtime-node-${index}`,
    name: `Runtime node ${index + 1}`,
    surface: { ...node.surface },
    position: [...node.position],
    rotation: [...node.rotation],
  })),
});

export const renderAvatarExpression = (
  definition: Readonly<AvatarDefinition>,
  expression: Expression,
  colors: { body?: string; eyes?: string } = {},
  blink = 1,
) => {
  const body = bodyFromDefinition(definition.body);
  return {
    geometry: renderAvatar(poseFromExpression(expression), body.primary, blink, {
      bodyNodes: body.nodes,
    }),
    colors: {
      body: colors.body ?? expression.bodyColor ?? definition.colors.body,
      eyes: colors.eyes ?? expression.eyeColor ?? definition.colors.eyes,
    },
  };
};
