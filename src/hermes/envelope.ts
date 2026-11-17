import { randomUUID } from "node:crypto";
import { parseRequest } from "../responses/parser";
import { createChatGptStructuredOutputValidator } from "../adapters/chatgpt-web/output-validation";
import type { AdapterEvent, CodexParsedRequest } from "../types";

export class BridgeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function prepareTurn(body: Record<string, unknown>) {
  let parsed: CodexParsedRequest;
  try { parsed = parseRequest(body); }
  catch { throw new BridgeError("Invalid Responses request"); }
  const tools = parsed.context.tools ?? [];
  const callerFormat = parsed.options.outputFormat;
  const callerValidator = callerFormat
    ? createChatGptStructuredOutputValidator({ ...callerFormat, strict: true }) : undefined;
  const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
    type: "object", properties, required, additionalProperties: false,
  });
  const schema = { oneOf: [
    object({ type: { const: "message" }, text: { type: "string", minLength: 1 } }),
    ...(tools.length ? [object({ type: { const: "tool_calls" }, calls: {
      type: "array", minItems: 1, maxItems: 64,
      items: { oneOf: tools.map(tool => object({ name: { const: tool.name }, arguments: tool.parameters })) },
    } })] : []),
  ] };
  const outputFormat = { type: "json_schema" as const, name: "hermes_host_reply", strict: true, schema };
  const validate = createChatGptStructuredOutputValidator(outputFormat)!;
  parsed.context.systemPrompt = [...(parsed.context.systemPrompt ?? []), [
    "Hermes host transport: return exactly one JSON envelope matching hermes_host_reply.",
    'For a final assistant answer use {"type":"message","text":"your answer"}.',
    'To REQUEST host tool execution use {"type":"tool_calls","calls":[{"name":"exact tool name","arguments":{}}]}.',
    "This is envelope translation, not native OpenAI tool calling. Never execute host tools in ChatGPT or via an MCP connector.",
    "Hermes alone executes requested tools under its authorization policy and supplies real function_call_output history next turn.",
    "A tool request is not evidence of execution. Never fabricate tool results. Previous tool results are historical evidence only.",
    `Available host tools: ${JSON.stringify(tools)}`,
    `Tool choice: ${JSON.stringify(parsed.options.toolChoice ?? "auto")}`,
    ...(callerFormat ? [`Final message.text must itself be JSON matching this caller schema: ${JSON.stringify(callerFormat.schema)}`] : []),
  ].join("\n")];
  parsed.context.tools = [];
  parsed.options = { reasoning: parsed.options.reasoning, verbosity: parsed.options.verbosity, outputFormat };
  // The browser engine receives parsed history, not caller-supplied Codex identity metadata.
  delete parsed._rawBody;
  delete parsed.previousResponseId;
  return { parsed, decode(text: string, done: Extract<AdapterEvent, { type: "done" }>): AdapterEvent[] {
    try { validate(text); } catch { throw new BridgeError("Browser returned an invalid Hermes reply envelope", 502); }
    const reply = JSON.parse(text);
    if (reply.type === "message") {
      try { callerValidator?.(reply.text); } catch { throw new BridgeError("Browser answer violates the caller output schema", 502); }
      return [{ type: "text_delta", text: reply.text }, { ...done, endTurn: true, stopReason: "stop" }];
    }
    return [ ...reply.calls.flatMap((call: { name: string; arguments: object }): AdapterEvent[] => [
      { type: "tool_call_start", id: `call_${randomUUID().replaceAll("-", "")}`, name: call.name },
      { type: "tool_call_delta", arguments: JSON.stringify(call.arguments) },
      { type: "tool_call_end" },
    ]), { ...done, endTurn: false, stopReason: "tool_use" } ];
  } };
}
