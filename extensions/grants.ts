import { Type } from "typebox";
import { MAX_CAPABILITY_DELEGATION_DEPTH, MAX_CAPABILITY_PATH_LENGTH, MAX_CAPABILITY_PATHS,
  MAX_CAPABILITY_TIMEOUT_MS, MAX_CAPABILITY_TOOL_LENGTH, MAX_CAPABILITY_TOOLS, MAX_CAPABILITY_TURNS } from "../lib/launch.ts";

const paths = () => Type.Array(Type.String({ minLength: 1, maxLength: MAX_CAPABILITY_PATH_LENGTH }),
  { maxItems: MAX_CAPABILITY_PATHS, uniqueItems: true });
export const capabilityGrant = Type.Object({
  tools: Type.Array(Type.String({ minLength: 1, maxLength: MAX_CAPABILITY_TOOL_LENGTH,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }), { maxItems: MAX_CAPABILITY_TOOLS, uniqueItems: true }),
  readPaths: paths(), writePaths: paths(),
  delegation: Type.Object({ maxDepth: Type.Integer({ minimum: 0, maximum: MAX_CAPABILITY_DELEGATION_DEPTH }) },
    { additionalProperties: false }),
  returnResults: Type.Boolean(),
  turns: Type.Integer({ minimum: 1, maximum: MAX_CAPABILITY_TURNS }),
  timeoutMs: Type.Integer({ minimum: 1, maximum: MAX_CAPABILITY_TIMEOUT_MS }),
}, { additionalProperties: false });
