import type { ChatRequest, ChatResponse, LlmProvider } from '../../src/llm/model.types.js';
import { ProviderError } from '../../src/llm/model.types.js';

export type Scripted = string | ProviderError;

/** A provider that replays a script, one entry per call, and records every request it saw. */
export class StubProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly requests: ChatRequest[] = [];
  constructor(
    private readonly script: Scripted[],
    readonly constrainsOutput = false,
  ) {}

  chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (next === undefined) return Promise.reject(new Error('stub provider script exhausted'));
    if (next instanceof ProviderError) return Promise.reject(next);
    return Promise.resolve({ content: next, promptTokens: 10, completionTokens: 5, latencyMs: 7 });
  }
}

export const silentLogger = {
  logs: [] as { message: string; params: unknown[] }[],
  log(message: string, ...params: unknown[]) {
    this.logs.push({ message, params });
  },
  warn(message: string, ...params: unknown[]) {
    this.logs.push({ message, params });
  },
};
