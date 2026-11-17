// Explicit browser I/O fixture for the real HTTP handler and Python OpenAI SDK.
import { createHermesHandler } from "../../src/hermes/handler";
import type { ProviderAdapter } from "../../src/adapters/base";

let submissions = 0;
const adapter: ProviderAdapter = {
  name: "sdk-contract-browser-fixture",
  async runTurn(parsed, _request, emit) {
    submissions++;
    if (parsed.context.messages.some(message => message.content === "invalid-envelope")) {
      emit({ type: "text_delta", text: "not a valid envelope" });
      emit({ type: "done", usage: { inputTokens: 12, outputTokens: 8, estimated: true } });
      return;
    }
    const result = parsed.context.messages.find(message => message.role === "toolResult");
    const streaming = parsed.context.messages.some(message => message.content === "stream-message");
    const answer = result ? { type: "message", text: `Actual host result: ${result.content}` }
      : streaming ? { type: "message", text: "SDK stream received" }
      : { type: "tool_calls", calls: [{ name: "hermes_test_add", arguments: { a: 2, b: 3 } }] };
    emit({ type: "heartbeat" });
    emit({ type: "text_delta", text: JSON.stringify(answer) });
    emit({ type: "done", usage: { inputTokens: 12, outputTokens: 8, estimated: true } });
  },
};
const handler = createHermesHandler({ apiKey: "sdk-contract-fixture-key", adapter,
  capabilities: { solAvailable: true, proAvailable: false, extraHighAvailable: false } });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch(request: Request) {
    if (new URL(request.url).pathname === "/__fixture/submissions") return Response.json({ submissions });
    return handler(request);
  },
});
console.log(`http://127.0.0.1:${server.port}/v1`);
