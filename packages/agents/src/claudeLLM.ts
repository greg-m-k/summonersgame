import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, llm } from "@livekit/agents";

export interface ClaudeLLMOptions {
  model?: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

/**
 * Claude adapter for the LiveKit Agents voice pipeline, on the current Anthropic SDK:
 * streaming, explicit effort (low keeps spoken replies snappy), and server-side refusal fallbacks.
 */
export class ClaudeLLM extends llm.LLM {
  readonly client: Anthropic;
  readonly opts: Required<ClaudeLLMOptions>;

  constructor(opts: ClaudeLLMOptions = {}) {
    super();
    this.client = new Anthropic();
    this.opts = {
      model: opts.model ?? "claude-opus-5-5",
      effort: opts.effort ?? "low",
      maxTokens: opts.maxTokens ?? 1024,
    };
    // A voice demon has no tools and lives on first-token latency, so on models that allow it
    // thinking is off (between_tools at low effort). Opus 5.5 cannot switch it off; effort is the
    // only knob there, and its thinking is short at low effort anyway.
    this.noThinking = /sonnet|haiku/.test(this.opts.model);
  }

  readonly noThinking: boolean;

  label(): string {
    return "anthropic.ClaudeLLM";
  }

  get model(): string {
    return this.opts.model;
  }

  get provider(): string {
    return "anthropic";
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
  }): llm.LLMStream {
    return new ClaudeStream(this, { chatCtx, toolCtx, connOptions });
  }
}

class ClaudeStream extends llm.LLMStream {
  private owner: ClaudeLLM;

  constructor(
    owner: ClaudeLLM,
    args: { chatCtx: llm.ChatContext; toolCtx?: llm.ToolContextLike; connOptions: APIConnectOptions },
  ) {
    super(owner, args);
    this.owner = owner;
  }

  protected async run(): Promise<void> {
    const { system, messages } = toAnthropic(this.chatCtx);
    const id = randomUUID();
    const stream = this.owner.client.beta.messages.stream(
      {
        model: this.owner.opts.model,
        max_tokens: this.owner.opts.maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.owner.opts.effort },
        ...(this.owner.noThinking ? { thinking: { type: "between_tools" as const } } : {}),
        system: systemBlocks(system),
        messages,
      },
      { signal: this.abortController.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
        this.queue.put({ id, delta: { role: "assistant", content: event.delta.text } });
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      this.logger.warn({ category: final.stop_details?.category }, "claude refused the demon turn");
    }
    const u = final.usage;
    this.queue.put({
      id,
      usage: {
        completionTokens: u.output_tokens,
        promptTokens: u.input_tokens,
        promptCachedTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        totalTokens: u.input_tokens + u.output_tokens,
      },
    });
  }
}

type Msg = Anthropic.Beta.BetaMessageParam;

/** Turns the demon carries into each call; older ones are dropped (the world summary is in the system prompt anyway). */
const MAX_HISTORY = 16;

/** Marks where the persona (static, cached) ends and the live world summary (changes every few seconds) begins. */
export const LIVE_MARK = "\n---LIVE---\n";

function systemBlocks(system: string): Anthropic.Beta.BetaTextBlockParam[] | undefined {
  if (!system) return undefined;
  const [persona, live] = system.split(LIVE_MARK);
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: persona!, cache_control: { type: "ephemeral" } }];
  if (live?.trim()) blocks.push({ type: "text", text: live });
  return blocks;
}

/** Flatten the agent's chat context into an Anthropic system string plus alternating messages. */
export function toAnthropic(chatCtx: llm.ChatContext): { system: string; messages: Msg[] } {
  const system: string[] = [];
  const messages: Msg[] = [];
  for (const item of chatCtx.items) {
    if (item.type === "message") {
      const text = contentText(item.content);
      if (!text) continue;
      if (item.role === "system" || item.role === "developer") {
        system.push(text);
        continue;
      }
      messages.push({ role: item.role, content: text });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: item.callId, name: item.name, input: safeJson(item.args) }],
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: item.callId, content: item.output, is_error: item.isError }],
      });
    }
  }
  while (messages.length > MAX_HISTORY) messages.shift();
  while (messages.length && messages[0]!.role !== "user") messages.shift();
  if (messages.length === 0 || messages[0]!.role !== "user") {
    messages.unshift({ role: "user", content: "(The player has just arrived in the dream.)" });
  }
  // Prefill is rejected on current models, so a conversation can never end on an assistant turn.
  if (messages[messages.length - 1]!.role === "assistant") {
    messages.push({ role: "user", content: "(Silence. Say something short in character, or provoke them.)" });
  }
  return { system: system.join("\n\n"), messages };
}

function contentText(content: llm.ChatContent[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") parts.push(c);
    else if (c && typeof c === "object" && "type" in c && c.type === "instructions") parts.push(c.value);
  }
  return parts.join("\n").trim();
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
