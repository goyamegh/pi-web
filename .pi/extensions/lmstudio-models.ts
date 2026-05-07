import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.LMSTUDIO_API_KEY ?? "lm-studio";
const PROVIDER_ID = process.env.LMSTUDIO_PROVIDER_ID ?? "lmstudio";

const DEFAULT_CONTEXT_WINDOW = Number(process.env.LMSTUDIO_CONTEXT_WINDOW ?? 128000);
const DEFAULT_MAX_TOKENS = Number(process.env.LMSTUDIO_MAX_TOKENS ?? 16384);

// LM Studio may expose embedding/reranking models from /v1/models too. Those are
// not usable as chat/code models in pi, so keep them out of /model by default.
const NON_CHAT_MODEL_PATTERN = /(embedding|embed|rerank|nomic-embed)/i;

type OpenAIModelsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    context_window?: number;
    max_context_length?: number;
    max_tokens?: number;
  }>;
};

async function discoverModels() {
  const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/models`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`LM Studio model discovery failed: HTTP ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as OpenAIModelsResponse;
  const seen = new Set<string>();

  return (payload.data ?? [])
    .filter((model) => typeof model.id === "string" && model.id.length > 0)
    .filter((model) => !NON_CHAT_MODEL_PATTERN.test(model.id!))
    .filter((model) => {
      if (seen.has(model.id!)) return false;
      seen.add(model.id!);
      return true;
    })
    .map((model) => ({
      id: model.id!,
      name: model.name ?? model.id!,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? model.max_context_length ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.max_tokens ?? DEFAULT_MAX_TOKENS,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens" as const,
      },
    }));
}

export default async function (pi: ExtensionAPI) {
  const models = await discoverModels();

  pi.registerProvider(PROVIDER_ID, {
    name: "LM Studio",
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    api: "openai-completions",
    models,
  });
}
