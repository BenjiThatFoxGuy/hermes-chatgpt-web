import * as z from "zod/v4";
import { BridgeError } from "./envelope";

const textPart = z.strictObject({ type: z.enum(["input_text", "output_text", "text"]), text: z.string(), annotations: z.array(z.unknown()).optional() });
const imagePart = z.strictObject({ type: z.literal("input_image"),
  image_url: z.string().regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
  detail: z.enum(["low", "high", "auto", "original"]).optional(),
});
const content = z.union([z.string(), z.array(z.union([textPart, imagePart]))]);
const message = z.strictObject({ type: z.literal("message").optional(),
  id: z.string().optional(), status: z.enum(["completed", "in_progress", "incomplete"]).optional(),
  role: z.enum(["system", "developer", "user", "assistant"]), content,
  phase: z.enum(["commentary", "final_answer"]).optional(),
}).refine(value => value.role !== "assistant" || typeof value.content === "string"
  || value.content.every(part => part.type !== "input_image"), "Assistant image history is unsupported");
const call = z.strictObject({ type: z.literal("function_call"), id: z.string().optional(),
  status: z.enum(["completed", "in_progress", "incomplete"]).optional(),
  call_id: z.string().min(1), name: z.string().min(1), arguments: z.string(),
});
const result = z.strictObject({ type: z.literal("function_call_output"), id: z.string().optional(),
  call_id: z.string().min(1), output: content,
});
const tool = z.strictObject({ type: z.literal("function"), name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional(), strict: z.boolean().optional(),
});
const namedTool = z.strictObject({ type: z.literal("function"), name: z.string().min(1) });
const choice = z.union([z.enum(["auto", "none", "required"]), namedTool,
  z.strictObject({ type: z.literal("allowed_tools"), mode: z.enum(["auto", "required"]), tools: z.array(namedTool).min(1) }),
]);
const schemaFormat = z.strictObject({ type: z.literal("json_schema"), name: z.string().min(1),
  strict: z.boolean().optional(), schema: z.union([z.record(z.string(), z.unknown()), z.boolean()]),
});
const requestSchema = z.strictObject({
  model: z.string().min(1), input: z.union([z.string(), z.array(z.union([message, call, result]))]),
  instructions: z.string().nullable().optional(), tools: z.array(tool).max(128).optional(),
  tool_choice: choice.optional(), parallel_tool_calls: z.boolean().optional(), stream: z.boolean().optional(),
  store: z.literal(false).optional(),
  // Optional enrichment/routing hints, not promises of encrypted replay or caching.
  include: z.array(z.literal("reasoning.encrypted_content")).max(1).optional(),
  prompt_cache_key: z.string().max(512).optional(),
  prompt_cache_retention: z.enum(["in-memory", "24h"]).optional(),
  reasoning: z.strictObject({ effort: z.string().optional(), summary: z.enum(["none", "auto"]).optional() }).nullable().optional(),
  text: z.strictObject({ verbosity: z.enum(["low", "medium", "high"]).optional(),
    format: z.union([schemaFormat, z.strictObject({ type: z.literal("text") })]).optional(),
  }).optional(),
});

/** Reject unsupported fields before the upstream parser can silently discard them. */
export function validateRequest(body: unknown): Record<string, unknown> {
  const checked = requestSchema.safeParse(body);
  if (!checked.success) throw new BridgeError(`Unsupported or malformed Responses request: ${checked.error.issues.map(issue => issue.path.join(".") || "request").join(", ")}`);
  const data = checked.data;
  const names = new Set<string>();
  for (const spec of data.tools ?? []) {
    if (names.has(spec.name)) throw new BridgeError("Tool names must be unique");
    names.add(spec.name);
    if (spec.parameters && spec.parameters.type !== undefined && spec.parameters.type !== "object") {
      throw new BridgeError("Function parameter schemas must describe an object");
    }
  }
  const selected = data.tool_choice;
  if (selected === "required" && !names.size) throw new BridgeError("Required tool choice needs an available function");
  if (typeof selected === "object") {
    const requested = "name" in selected ? [selected.name] : selected.tools.map(spec => spec.name);
    if (requested.some(name => !names.has(name))) throw new BridgeError("Tool choice references an unadvertised function");
  }
  const calls = new Set<string>();
  const results = new Set<string>();
  if (Array.isArray(data.input)) for (const item of data.input) {
    if (item.type === "function_call") {
      if (calls.has(item.call_id)) throw new BridgeError("History contains duplicate function call IDs");
      calls.add(item.call_id);
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch { throw new BridgeError("Historical function arguments must be JSON"); }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new BridgeError("Historical function arguments must be an object");
    } else if (item.type === "function_call_output") {
      if (!calls.has(item.call_id) || results.has(item.call_id)) throw new BridgeError("Tool output must reference one preceding function call");
      results.add(item.call_id);
    }
  }
  // Do not leak routing keys into browser prompts or manufacture replayable reasoning.
  // Response headers explicitly advertise that these optional enrichments are unavailable.
  const { include: _include, prompt_cache_key: _cacheKey, prompt_cache_retention: _retention, ...semantic } = data;
  if (semantic.reasoning?.summary === "auto") {
    const { summary: _summary, ...reasoning } = semantic.reasoning;
    semantic.reasoning = reasoning;
  }
  return semantic as Record<string, unknown>;
}
