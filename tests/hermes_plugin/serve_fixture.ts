// Explicit browser I/O fixture for the real HTTP handler and Python OpenAI SDK.
import { createHermesHandler } from "../../src/hermes/handler";
import type { ProviderAdapter } from "../../src/adapters/base";

const adapter: ProviderAdapter = {
  name: "sdk-contract-browser-fixture",
  async runTurn(parsed, _request, emit) {
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
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch: createHermesHandler({ apiKey: "sdk-contract-fixture-key", adapter,
    capabilities: { solAvailable: true, proAvailable: false, extraHighAvailable: false } }),
});
console.log(`http://127.0.0.1:${server.port}/v1`);
