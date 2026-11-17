import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "../adapters/base";
import { ChatGptBrowserWorker, type BrowserTurn } from "../adapters/chatgpt-web/browser-worker";
import { compileChatGptWebPrompt } from "../adapters/chatgpt-web/prompt";
import { createChatGptStructuredOutputValidator } from "../adapters/chatgpt-web/output-validation";
import { estimateChatGptWebUsage } from "../adapters/chatgpt-web/usage";
import type { CodexProviderConfig } from "../types";

/** Use the upstream browser engine without its Codex replay registry or MCP broker. */
export function createHermesBrowserAdapter(
  provider: CodexProviderConfig,
  browser?: { run(turn: BrowserTurn): Promise<string> },
): ProviderAdapter {
  if (provider.chatgptWeb?.browserInteractionMode === "manual") {
    throw new Error("Hermes requires automatic browser mode; manual mode depends on the Codex MCP harness");
  }
  const safeProvider: CodexProviderConfig = { ...provider, chatgptWeb: {
    ...provider.chatgptWeb, localToolsEnabled: false, autoApproveToolCalls: false,
    experimentalFreshConversationPerTurn: true, experimentalBiggerContext: false,
    experimentalSkillAttachments: false, threadEnvironmentStatePath: undefined, lunaCheckpointStatePath: undefined,
  } };
  const worker = browser ?? ChatGptBrowserWorker.forProvider(safeProvider);
  const capabilities = { localToolsEnabled: false, solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true, proAvailable: provider.chatgptWeb?.proAvailable === true };
  return { name: "hermes-chatgpt-browser", async runTurn(parsed, incoming, emit) {
    incoming.abortSignal?.throwIfAborted();
    const validate = createChatGptStructuredOutputValidator(parsed.options.outputFormat);
    const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
    try {
      const answer = await worker.run({
        // This is a browser activity ID, not a native Codex thread or turn identity.
        traceId: `hermes_${randomUUID().replaceAll("-", "")}`,
        modelId: parsed.modelId, reasoning: parsed.options.reasoning, modelFamily: parsed._chatgptModelFamily,
        capabilities, retainConversation: false, nativeConnector: false,
        abortSignal: incoming.abortSignal,
        prepare: async () => ({ ...compileChatGptWebPrompt(parsed, capabilities), release() {} }),
        onTextDelta() {},
        onHeartbeat: () => emit({ type: "heartbeat" }),
      });
      incoming.abortSignal?.throwIfAborted();
      validate?.(answer);
      emit({ type: "text_delta", text: answer, phase: "final_answer" });
      emit({ type: "done", usage: estimateChatGptWebUsage(parsed, { answer }, capabilities, false, false, provider.chatgptWeb?.appName) });
    } finally { clearInterval(heartbeat); }
  } };
}
