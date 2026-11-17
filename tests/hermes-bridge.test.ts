import { expect, test } from "bun:test";
import { createHermesHandler } from "../src/hermes/handler";
import type { CodexParsedRequest, AdapterEvent } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";

const model = "chatgpt-web/gpt-6-sol";
const capabilities = { solAvailable: true, proAvailable: false, extraHighAvailable: false };
const key = "test-local-bridge-key";
const tool = { type: "function", name: "read_file", description: "Read a file", parameters: {
  type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
} };
function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:8766/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, input: "Read the file", ...body }),
  });
}
function fixture(answer: unknown, observed: CodexParsedRequest[] = []): ProviderAdapter {
  return { name: "browser-fixture", async runTurn(parsed, incoming, emit) {
    observed.push(parsed);
    expect(incoming.headers.get("authorization")).toBeNull();
    emit({ type: "heartbeat" });
    const text = JSON.stringify(answer);
    emit({ type: "text_delta", text: text.slice(0, 15) });
    emit({ type: "text_delta", text: text.slice(15) });
    emit({ type: "done", usage: { inputTokens: 10, outputTokens: 5, estimated: true } });
  } };
}

test("HTTP Responses round trip exposes a host tool call and replays canonical history with images", async () => {
  const observed: CodexParsedRequest[] = [];
  const handler = createHermesHandler({ apiKey: key, capabilities,
    adapter: fixture({ type: "tool_calls", calls: [{ name: "read_file", arguments: { path: "/notes" } }] }, observed) });
  const response = await handler(request({ tools: [tool], input: [{ role: "user", content: [
    { type: "input_text", text: "Read this" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
  ] }] }));
  expect(response.status).toBe(200);
  const json = await response.json() as any;
  expect(json.status).toBe("completed");
  expect(json.output).toHaveLength(1);
  expect(json.output[0]).toMatchObject({ type: "function_call", name: "read_file", arguments: '{"path":"/notes"}' });
  expect(json.output[0].call_id).toMatch(/^call_/);
  expect(observed[0]!.context.tools ?? []).toHaveLength(0);
  expect(observed[0]!.options.outputFormat?.strict).toBe(true);
  expect(observed[0]!.context.messages[0]!.content).toContainEqual({ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" });
  const nextObserved: CodexParsedRequest[] = [];
  const next = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: "File contents received" }, nextObserved) });
  const continued = await next(request({ tools: [tool], input: [
    { role: "user", content: "Read /notes" }, json.output[0],
    { type: "function_call_output", call_id: json.output[0].call_id, output: "Actual file content" },
  ] }));
  expect(continued.status).toBe(200);
  const result = await continued.json() as any;
  expect(result.output[0].content[0].text).toBe("File contents received");
  expect(nextObserved[0]!.context.messages.some(m => m.role === "toolResult" && m.toolCallId === json.output[0].call_id && m.content === "Actual file content")).toBe(true);
});
