import { z } from "zod";
import { zodToJsonSchema as upstream } from "zod-to-json-schema";

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return upstream(schema, { target: "openApi3" }) as Record<string, unknown>;
}
