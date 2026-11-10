import {
  type ChatRequest,
  type ChatResponse,
  type LlmProvider,
  ProviderError,
} from './model.types.js';
import type { Semaphore } from './semaphore.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  /** Secret. Only ever placed in the Authorization header; never logged or put in an error. */
  apiKey: string | undefined;
  semaphore: Semaphore;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionBody {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Ollama Cloud via its OpenAI-compatible endpoint. Everything Ollama-specific (auth, status-code
 * meaning, response shape) is translated to ProviderError kinds here.
 *
 * Probe result (see docs): Ollama Cloud ignores `format` / `response_format` schemas, so
 * `constrainsOutput` is false and `jsonSchema` is never sent.
 */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly constrainsOutput = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OllamaProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { apiKey, baseUrl, semaphore } = this.options;
    // Checked here, at the point of use, so unit tests and `npm test` need no key.
    if (apiKey === undefined) {
      throw new ProviderError(
        'unavailable',
        'OLLAMA_API_KEY is not set (create one at https://ollama.com/settings/keys)',
      );
    }
    return await semaphore.run(async () => {
      const started = Date.now();
      const elapsed = (): number => Date.now() - started;
      let res: Response;
      try {
        res = await this.fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: request.model,
            temperature: request.temperature,
            messages: [{ role: 'user', content: request.prompt }],
          }),
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new ProviderError(
            'timeout',
            `request timed out after ${String(request.timeoutMs)}ms`,
            undefined,
            elapsed(),
          );
        }
        // The error text is deliberately dropped: it is not needed and must never carry headers.
        throw new ProviderError(
          'transport',
          'network error talking to the provider',
          undefined,
          elapsed(),
        );
      }

      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(
          'unavailable',
          `authentication rejected (HTTP ${String(res.status)})`,
          res.status,
          elapsed(),
        );
      }
      if (res.status === 429) {
        throw new ProviderError(
          'queue_full',
          'provider concurrency limit reached (HTTP 429)',
          429,
          elapsed(),
        );
      }
      if (res.status === 408) {
        throw new ProviderError(
          'timeout',
          'provider reported a request timeout (HTTP 408)',
          408,
          elapsed(),
        );
      }
      if (res.status >= 500) {
        throw new ProviderError(
          'unavailable',
          `provider error (HTTP ${String(res.status)})`,
          res.status,
          elapsed(),
        );
      }
      if (!res.ok) {
        throw new ProviderError(
          'rejected',
          `request rejected (HTTP ${String(res.status)})`,
          res.status,
          elapsed(),
        );
      }

      let body: ChatCompletionBody;
      try {
        body = (await res.json()) as ChatCompletionBody;
      } catch {
        throw new ProviderError(
          'transport',
          'provider returned a non-JSON body',
          res.status,
          elapsed(),
        );
      }
      const content = body.choices?.[0]?.message?.content;
      return {
        content: typeof content === 'string' ? content : '',
        promptTokens: num(body.usage?.prompt_tokens),
        completionTokens: num(body.usage?.completion_tokens),
        latencyMs: elapsed(),
      };
    });
  }
}
