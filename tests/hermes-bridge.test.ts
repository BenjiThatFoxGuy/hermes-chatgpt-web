import { expect, test } from "bun:test";
import { createHermesHandler } from "../src/hermes/handler";
import type { CodexParsedRequest, AdapterEvent } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";
import { createHermesBrowserAdapter } from "../src/hermes/browser";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { startHermesServer } from "../src/hermes/server";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

test("real browser boundary compiles full history without Codex identities or MCP execution", async () => {
  const turns: BrowserTurn[] = [];
  const worker = { async run(turn: BrowserTurn) {
    turns.push(turn);
    const prompt = await turn.prepare();
    expect(prompt.turnToken).toBeUndefined();
    expect(prompt.images).toHaveLength(1);
    expect(prompt.text).toContain("hermes_host_reply");
    expect(prompt.text).toContain("read_file");
    expect(turn.capabilities.localToolsEnabled).toBe(false);
    expect(turn.retainConversation).not.toBe(true);
    expect(turn.nativeConnector).not.toBe(true);
    expect(turn.conversationKey).toBeUndefined();
    const answer = '{"type":"message","text":"Image received"}';
    turn.onTextDelta(answer);
    prompt.release();
    return answer;
  } };
  const adapter = createHermesBrowserAdapter({ adapter: "chatgpt-web", baseUrl: "https://chatgpt.com",
    chatgptWeb: { ...capabilities, localToolsEnabled: true } }, worker);
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter });
  for (let i = 0; i < 2; i++) {
    const res = await handler(request({ tools: [tool], input: [{ role: "user", content: [
      { type: "input_text", text: "Inspect" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
    ] }] }));
    expect(res.status).toBe(200);
    expect((await res.json() as any).output[0].content[0].text).toBe("Image received");
  }
  expect(turns[0]!.traceId).not.toBe(turns[1]!.traceId);
  expect(turns[0]!.modelFamily).toBe("6");
});

test("buffered envelope SSE emits standard function call events with stable call IDs", async () => {
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "tool_calls", calls: [{ name: "read_file", arguments: { path: "/a" } }] }) });
  const res = await handler(request({ stream: true, tools: [tool] }));
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const frames = (await res.text()).split("\n\n").flatMap(frame => {
    const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
  expect(frames[0].type).toBe("response.created");
  const added = frames.find(f => f.type === "response.output_item.added" && f.item.type === "function_call");
  const ended = frames.find(f => f.type === "response.output_item.done" && f.item.type === "function_call");
  expect(added.item.call_id).toBe(ended.item.call_id);
  expect(ended.item.arguments).toBe('{"path":"/a"}');
  const completed = frames.find(f => f.type === "response.completed");
  expect(completed.response.output[0].call_id).toBe(ended.item.call_id);
});

test("canceling a streaming response aborts the underlying browser turn", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void;
  const canceled = new Promise<void>(resolve => { aborted = resolve; });
  const adapter: ProviderAdapter = { name: "pending-browser", async runTurn(_parsed, incoming) {
    started();
    await new Promise<void>(resolve => incoming.abortSignal!.addEventListener("abort", () => { aborted(); resolve(); }, { once: true }));
  } };
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter });
  const res = await handler(request({ stream: true }));
  await ready;
  await res.body!.cancel();
  await canceled;
});

const secondTool = { ...tool, name: "write_file" };
const callReply = { type: "tool_calls", calls: [{ name: "read_file", arguments: { path: "/a" } }] };
test.each([
  ["none", callReply], ["required", { type: "message", text: "Skipped tools" }],
  [{ type: "function", name: "write_file" }, callReply],
  [{ type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "write_file" }] }, callReply],
])("tool_choice %j is enforced rather than merely included in the prompt", async (choice, reply) => {
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture(reply) });
  expect((await handler(request({ tools: [tool, secondTool], tool_choice: choice }))).status).toBe(502);
});

test("parallel_tool_calls false rejects a browser reply requesting two calls", async () => {
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "tool_calls", calls: [callReply.calls[0], callReply.calls[0]] }) });
  expect((await handler(request({ tools: [tool], parallel_tool_calls: false }))).status).toBe(502);
});

test.each([
  { previous_response_id: "resp_prior" }, { temperature: 0.3 }, { max_output_tokens: 20 },
  { unknown_control: true }, { store: true }, { metadata: { turn_id: "fake" } },
  { tools: [{ type: "web_search" }] }, { tools: [{ ...tool, parameters: { type: "array" } }] },
  { tools: [tool, tool] }, { tools: [tool], tool_choice: { type: "function", name: "missing" } },
  { tools: [tool], tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "web_search" }] } },
  { input: [{ type: "function_call_output", call_id: "orphan", output: "invented" }] },
  { input: [{ role: "user", content: [{ type: "input_file", file_id: "missing" }] }] },
  { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/image.png" }] }] },
  { input: [{ type: "compaction", encrypted_content: "opaque" }] },
  { text: { format: { type: "json_object" } } },
  { reasoning: { effort: "xhigh" } },
])("unsupported or malformed request fails before starting browser: %j", async body => {
  const observed: CodexParsedRequest[] = [];
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: "ok" }, observed) });
  expect((await handler(request(body))).status).toBe(400);
  expect(observed).toHaveLength(0);
});

test("caller reasoning effort is routed to the browser instead of silently reset", async () => {
  const observed: CodexParsedRequest[] = [];
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: "ok" }, observed) });
  expect((await handler(request({ reasoning: { effort: "medium" } }))).status).toBe(200);
  expect(observed[0]!.options.reasoning).toBe("medium");
});

test.each([
  { type: "tool_calls", calls: [{ name: "unlisted", arguments: {} }] },
  { type: "tool_calls", calls: [{ name: "read_file", arguments: { path: 123 } }] },
  { type: "tool_calls", calls: [{ name: "read_file", arguments: "{}" }] },
  { type: "tool_calls", calls: [] }, { type: "message", text: "ok", calls: [] },
])("malformed or unauthorized reply envelope fails closed: %j", async reply => {
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture(reply) });
  const res = await handler(request({ tools: [tool] }));
  expect(res.status).toBe(502);
  expect(res.headers.get("x-should-retry")).toBe("false");
});

test("strict caller JSON output schema is preserved within message.text", async () => {
  const body = { text: { format: { type: "json_schema", name: "result", strict: true,
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } } };
  const good = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: '{"ok":true}' }) });
  expect((await good(request(body))).status).toBe(200);
  const bad = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: '{"ok":"yes"}' }) });
  expect((await bad(request(body))).status).toBe(502);
});

test("auth, browser origin, loopback authority, methods and routes fail closed", async () => {
  const observed: CodexParsedRequest[] = [];
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: "ok" }, observed) });
  for (const [headers, status] of [
    [{ Authorization: "" }, 401], [{ Authorization: "Bearer wrong" }, 401],
    [{ Origin: "null" }, 403], [{ "Sec-Fetch-Site": "cross-site" }, 403],
    [{ Host: "evil.example" }, 403],
  ] as [Record<string, string>, number][]) {
    const res = await handler(request({}, headers));
    expect(res.status).toBe(status);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  }
  for (const [url, method, status] of [
    ["http://evil.example/v1/models", "GET", 403], ["http://127.0.0.1:8766/v1/responses/", "GET", 404],
    ["http://127.0.0.1:8766/v1/responses", "GET", 405],
  ] as const) {
    expect((await handler(new Request(url, { method, headers: { Authorization: `Bearer ${key}` } }))).status).toBe(status);
  }
  expect(observed).toHaveLength(0);
  expect(() => createHermesHandler({ apiKey: "", capabilities, adapter: fixture({}) })).toThrow();
});

test("body limit counts streamed bytes without trusting Content-Length", async () => {
  const observed: CodexParsedRequest[] = [];
  const handler = createHermesHandler({ apiKey: key, capabilities, maxBodyBytes: 100, adapter: fixture({ type: "message", text: "ok" }, observed) } as any);
  const bytes = new TextEncoder().encode(JSON.stringify({ model, input: "x".repeat(200) }));
  const req = new Request("http://127.0.0.1:8766/v1/responses", { method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 50)); controller.enqueue(bytes.slice(50)); controller.close(); } }),
  });
  expect((await handler(req)).status).toBe(413);
  expect(observed).toHaveLength(0);
});

test("browser heartbeats remain adapter progress while the envelope is buffered", async () => {
  const adapter: ProviderAdapter = { name: "slow-browser", async runTurn(_parsed, _incoming, emit) {
    const interval = setInterval(() => emit({ type: "heartbeat" }), 30);
    await new Promise(resolve => setTimeout(resolve, 1350));
    clearInterval(interval);
    emit({ type: "text_delta", text: '{"type":"message","text":"Still healthy"}' });
    emit({ type: "done" });
  } };
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter, heartbeatMs: 25, stallTimeoutSec: 1 } as any);
  const res = await handler(request({ stream: true }));
  const text = await res.text();
  expect(text).toContain("response.completed");
  expect(text).not.toContain("upstream_stall_timeout");
});

test("executable server binds loopback and serves only configured browser model capabilities", async () => {
  const server = startHermesServer({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: "Socket reply" }), port: 0, modelAllowlist: [model] });
  try {
    expect(server.hostname).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;
    const catalog = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: "error" });
    expect(catalog.status).toBe(200);
    expect((await catalog.json() as any).data.map((entry: any) => entry.id)).toEqual([model]);
    const res = await fetch(`${base}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: "socket message" }), redirect: "error" });
    expect(res.status).toBe(200);
    expect((await res.json() as any).output[0].content[0].text).toBe("Socket reply");
  } finally { await server.stop(true); }
});

test("executable fails clearly without a local bearer or configured browser runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "hermes-bridge-missing-runtime-"));
  try {
    for (const token of ["", key]) {
      const proc = Bun.spawn([process.execPath, "run", "src/hermes/server.ts"], {
        env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CHATGPT_WEB_API_KEY: token }, stdout: "pipe", stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(1);
      expect(stderr).toContain(token ? "browser runtime" : "CHATGPT_WEB_API_KEY");
      expect(stderr).not.toContain(key);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("actual socket stream disconnect aborts the browser turn", async () => {
  let observed!: () => void;
  const aborted = new Promise<void>(resolve => { observed = resolve; });
  const adapter: ProviderAdapter = { name: "socket-browser", async runTurn(_parsed, incoming) {
    await new Promise<void>(resolve => incoming.abortSignal!.addEventListener("abort", () => { observed(); resolve(); }, { once: true }));
  } };
  const server = startHermesServer({ apiKey: key, capabilities, adapter, port: 0 });
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: "slow browser", stream: true }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await aborted;
  } finally { await server.stop(true); }
});

test("canonical assistant message output can be replayed without losing text", async () => {
  const observed: CodexParsedRequest[] = [];
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: "Next" }, observed) });
  const res = await handler(request({ input: [
    { role: "user", content: "first" },
    { type: "message", id: "msg_prior", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Previous answer", annotations: [] }] },
    { role: "user", content: "next" },
  ] }));
  expect(res.status).toBe(200);
  expect(observed[0]!.context.messages.some(message => message.role === "assistant" && message.content.some(part => part.type === "text" && part.text === "Previous answer"))).toBe(true);
});

test("function argument schemas preserve local JSON references", async () => {
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture(callReply) });
  const res = await handler(request({ tools: [{ ...tool, parameters: { type: "object", properties: { path: { $ref: "#/$defs/path" } }, required: ["path"], additionalProperties: false, $defs: { path: { type: "string" } } } }] }));
  expect(res.status).toBe(200);
});

test.each([
  { include: [], prompt_cache_key: "pck_main_transport" },
  { include: [], reasoning: { effort: "none" }, prompt_cache_key: "pck_disabled_reasoning_transport" },
  { include: ["reasoning.encrypted_content"], reasoning: { effort: "medium", summary: "auto" }, prompt_cache_key: "pck_reasoning_transport" },
  { reasoning: { effort: "medium", summary: "auto" }, prompt_cache_key: "pck_auxiliary_transport", prompt_cache_retention: "24h" },
])("Hermes transport hints are accepted without inventing reasoning state or prompt caching: %j", async hints => {
  const observed: CodexParsedRequest[] = [];
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: "Compatible reply" }, observed) });
  for (const stream of [false, true]) {
    const response = await handler(request({ ...hints, stream, store: false }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-chatgpt-web-prompt-cache")).toBe("unsupported");
    expect(response.headers.get("x-chatgpt-web-reasoning-state")).toBe("unavailable");
    expect(response.headers.get("x-chatgpt-web-reasoning-summary")).toBe("unavailable");
    const output = await response.text();
    expect(output).toContain("Compatible reply");
    expect(output).not.toContain("encrypted_content");
    if (!stream) expect(JSON.parse(output).usage.input_tokens_details.cached_tokens).toBe(0);
    expect(observed.at(-1)!._rawBody).toBeUndefined();
    expect(observed.at(-1)!.options.promptCacheKey).toBeUndefined();
  }
});

test.each([
  { include: ["web_search_call.action.sources"] },
  { include: ["reasoning.encrypted_content", "message.output_text.logprobs"] },
  { prompt_cache_retention: "forever" },
  { input: [{ type: "reasoning", encrypted_content: "opaque-state-not-issued-by-browser" }] },
])("unsupported hint or actual encrypted replay still fails before browser submission: %j", async controls => {
  const observed: CodexParsedRequest[] = [];
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "message", text: "ok" }, observed) });
  expect((await handler(request(controls))).status).toBe(400);
  expect(observed).toHaveLength(0);
});

test("streaming invalid envelope never leaks raw or unauthorized output", async () => {
  const handler = createHermesHandler({ apiKey: key, capabilities, adapter: fixture({ type: "tool_calls", calls: [{ name: "unlisted", arguments: {} }] }) });
  const response = await handler(request({ tools: [tool], stream: true }));
  const stream = await response.text();
  expect(stream).toContain("response.failed");
  expect(stream).not.toContain("unlisted");
  expect(stream).not.toContain("response.function_call_arguments.delta");
});

