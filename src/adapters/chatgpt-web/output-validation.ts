import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { CodexJsonSchemaOutputFormat } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";

export type ChatGptStructuredOutputValidator = (answer: string) => void;

const MARKDOWN_ESCAPES = new Set(["_", "*", "~", "#", "[", "]", "(", ")", ">", "+", "-", ".", "!", "|", "{", "}", "<"]);
const JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** Undo only renderer-added Markdown escapes that are illegal in JSON strings. */
export function parseChatGptStructuredJson(answer: string): unknown {
  try { return JSON.parse(answer); } catch { /* normalize the rendered form below */ }
  let normalized = "";
  let inString = false;
  for (let index = 0; index < answer.length; index++) {
    const char = answer[index]!;
    if (char === '"') {
      inString = !inString;
      normalized += char;
      continue;
    }
    if (char === "\\" && index + 1 < answer.length) {
      const next = answer[index + 1]!;
      if (inString && JSON_ESCAPES.has(next)) {
        normalized += char + next;
        index++;
        continue;
      }
      if (MARKDOWN_ESCAPES.has(next)) {
        normalized += next;
        index++;
        continue;
      }
    }
    normalized += char;
  }
  return JSON.parse(normalized);
}

function validationError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502,
    errorType: "server_error",
    code: "structured_output_validation_failed",
    retryable: false,
  });
}

export function createChatGptStructuredOutputValidator(
  format: CodexJsonSchemaOutputFormat | undefined,
): ChatGptStructuredOutputValidator | undefined {
  if (!format?.strict) return undefined;

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    validateFormats: true,
  });
  addFormats(ajv);

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(format.schema as object | boolean);
  } catch (cause) {
    throw new ChatGptWebAdapterError(
      `Codex supplied an invalid strict JSON schema ${JSON.stringify(format.name)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        status: 400,
        errorType: "invalid_request_error",
        code: "invalid_output_schema",
        retryable: false,
      },
    );
  }

  return (answer: string): void => {
    let value: unknown;
    try {
      value = parseChatGptStructuredJson(answer);
    } catch {
      throw validationError(
        `ChatGPT Web returned malformed JSON for strict Codex output schema ${JSON.stringify(format.name)}`,
      );
    }
    if (validate(value)) return;
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    throw validationError(
      `ChatGPT Web returned JSON that does not satisfy strict Codex output schema ${JSON.stringify(format.name)}${detail ? `: ${detail}` : ""}`,
    );
  };
}
