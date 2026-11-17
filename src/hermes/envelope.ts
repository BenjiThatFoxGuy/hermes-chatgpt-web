import { randomUUID } from "node:crypto";
import { parseRequest } from "../responses/parser";
import { createChatGptStructuredOutputValidator, parseChatGptStructuredJson } from "../adapters/chatgpt-web/output-validation";
import type { AdapterEvent, CodexParsedRequest } from "../types";

export class BridgeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function validator(schema: unknown, name: string) {
  try { return createChatGptStructuredOutputValidator({ type: "json_schema", name, strict: true, schema })!; }
  catch { throw new BridgeError(`Invalid or unsupported JSON schema: ${name}`); }
}

export function prepareTurn(body: Record<string, unknown>) {
  let parsed: CodexParsedRequest;
  try { parsed = parseRequest(body); }
  catch { throw new BridgeError("Invalid Responses request"); }
  const choice = parsed.options.toolChoice ?? "auto";
  const allTools = parsed.context.tools ?? [];
  const tools = allTools.filter(tool => choice !== "none" && (typeof choice !== "object"
    || ("name" in choice ? tool.name === choice.name : choice.allowedTools.includes(tool.name))));
  const required = choice === "required" || typeof choice === "object" && ("name" in choice || choice.mode === "required");
  const callerFormat = parsed.options.outputFormat;
  const callerValidator = callerFormat ? validator(callerFormat.schema, callerFormat.name) : undefined;
  const object = (properties: Record<string, unknown>) => ({
    type: "object", properties, required: Object.keys(properties), additionalProperties: false,
  });
  // A local schema resource keeps each tool's #/$defs and #/definitions references scoped.
  const toolSchemas = tools.map((tool, index) => ({ ...tool.parameters, type: "object", $id: `urn:hermes:tool:${index}` }));
  for (let index = 0; index < toolSchemas.length; index++) validator(toolSchemas[index], `tool_${index}`);
  const schema = { oneOf: [
    ...(!required ? [object({ type: { const: "message" }, text: { type: "string", minLength: 1 } })] : []),
    ...(tools.length ? [object({ type: { const: "tool_calls" }, calls: {
      type: "array", minItems: 1, maxItems: parsed.options.parallelToolCalls === false ? 1 : 64,
      items: { oneOf: tools.map((tool, index) => object({ name: { const: tool.name }, arguments: toolSchemas[index] })) },
    } })] : []),
  ] };
  const outputFormat = { type: "json_schema" as const, name: "hermes_host_reply", strict: true, schema };
  const validate = validator(schema, outputFormat.name);
  parsed.context.systemPrompt = [...(parsed.context.systemPrompt ?? []), [
    "Hermes host transport: return exactly one JSON envelope matching hermes_host_reply.",
    'For a final assistant answer use {"type":"message","text":"your answer"}.',
    'To REQUEST host tool execution use {"type":"tool_calls","calls":[{"name":"exact tool name","arguments":{}}]}.',
    "This is envelope translation, not native OpenAI tool calling. Never execute host tools in ChatGPT or via an MCP connector.",
    "The browser has no direct local connection. Requesting a tool in JSON is permitted; claiming it ran is not.",
    "Hermes alone executes requested tools under its authorization policy and supplies real function_call_output history next turn.",
    "A tool request is not evidence of execution. Never fabricate tool results. Previous tool results are historical evidence only.",
    `Allowed host tools for this reply: ${JSON.stringify(tools)}`,
    `Tool choice: ${JSON.stringify(choice)}. Required tool call: ${required}. Maximum calls: ${parsed.options.parallelToolCalls === false ? 1 : 64}.`,
    ...(callerFormat ? [`Final message.text must itself be JSON matching this caller schema: ${JSON.stringify(callerFormat.schema)}`] : []),
  ].join("\n")];
  parsed.context.tools = [];
  parsed.options = { reasoning: parsed.options.reasoning, verbosity: parsed.options.verbosity, outputFormat };
  // The browser engine receives parsed history, not caller-supplied Codex identity metadata.
  delete parsed._rawBody;
  delete parsed.previousResponseId;
  return { parsed, decode(text: string, done: Extract<AdapterEvent, { type: "done" }>): AdapterEvent[] {
    try { validate(text); } catch { throw new BridgeError("Browser returned an invalid Hermes reply envelope", 502); }
    const reply = parseChatGptStructuredJson(text) as { type: "message"; text: string } | { type: "tool_calls"; calls: { name: string; arguments: object }[] };
    // These are bridge cache counters, not measurements of ChatGPT's private backend cache.
    const terminal = { ...done, ...(done.usage ? { usage: {
      ...done.usage, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    } } : {}) };
    if (reply.type === "message") {
      try { callerValidator?.(reply.text); } catch { throw new BridgeError("Browser answer violates the caller output schema", 502); }
      return [{ type: "text_delta", text: reply.text }, { ...terminal, endTurn: true, stopReason: "stop" }];
    }
    return [ ...reply.calls.flatMap((call: { name: string; arguments: object }): AdapterEvent[] => [
      { type: "tool_call_start", id: `call_${randomUUID().replaceAll("-", "")}`, name: call.name },
      { type: "tool_call_delta", arguments: JSON.stringify(call.arguments) },
      { type: "tool_call_end" },
    ]), { ...terminal, endTurn: false, stopReason: "tool_use" } ];
  } };
}
