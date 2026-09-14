import { AGENT_SYSTEM_PROMPT, buildAgentUserPrompt } from './prompt.js';
import { normalizeAgentPatch, type AgentPatch } from './schema.js';
import type { AgentContext, DraftState } from './resolve.js';

/**
 * LLM-backed parser (DeepSeek-compatible chat completions API).
 *
 * Deliberately tiny: one HTTP call, JSON mode, temperature 0, hard timeout, and
 * a defensive normalizer on the way out. If anything goes wrong the caller falls
 * back to the deterministic rule parser, so a model outage degrades quality
 * rather than availability.
 */

export interface LlmConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = (env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY ?? '').trim();
  const baseUrl = (env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = env.LLM_MODEL ?? 'deepseek-chat';
  const disabled = env.LLM_DISABLED === '1' || env.LLM_DISABLED === 'true';
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? 20000);
  return {
    enabled: !disabled && apiKey !== '',
    apiKey,
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000,
  };
}

export interface LlmParseResult {
  patch: AgentPatch | null;
  error: string | null;
  latencyMs: number;
}

export async function parseWithLlm(
  text: string,
  ctx: AgentContext,
  options: {
    config: LlmConfig;
    pendingDraft?: DraftState | null;
    recentNotes?: string[];
    /** Business-rule violations from a previous attempt, so the model can fix them. */
    repair?: { violations: { rule: string; message: string }[] };
  },
): Promise<LlmParseResult> {
  const startedAt = Date.now();
  if (!options.config.enabled) {
    return { patch: null, error: 'llm_disabled', latencyMs: 0 };
  }

  const userPrompt = buildAgentUserPrompt(text, ctx, {
    pendingDraft: options.pendingDraft ?? null,
    recentNotes: options.recentNotes,
  });

  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  if (options.repair && options.repair.violations.length > 0) {
    messages.push({
      role: 'user',
      content:
        '你上一次的输出没有通过业务校验，请修正后重新输出 JSON：\n' +
        options.repair.violations.map((v) => `- ${v.rule}: ${v.message}`).join('\n'),
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.config.timeoutMs);
  try {
    const response = await fetch(`${options.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.config.apiKey}`,
      },
      body: JSON.stringify({
        model: options.config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        patch: null,
        error: `llm_http_${response.status}: ${body.slice(0, 200)}`,
        latencyMs: Date.now() - startedAt,
      };
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content ?? '';
    if (content.trim() === '') {
      return { patch: null, error: 'llm_empty_response', latencyMs: Date.now() - startedAt };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(content));
    } catch {
      return { patch: null, error: 'llm_invalid_json', latencyMs: Date.now() - startedAt };
    }

    const patch = normalizeAgentPatch(parsed);
    if (patch.action === 'unknown') {
      return { patch: null, error: 'llm_unknown_action', latencyMs: Date.now() - startedAt };
    }
    return { patch, error: null, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { patch: null, error: `llm_failed: ${message}`, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}
