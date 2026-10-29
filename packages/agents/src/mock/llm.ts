import { randomUUID } from "node:crypto";
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, delay, llm } from "@livekit/agents";
import { UNINTELLIGIBLE_PREFIX } from "@summoners/shared";

export interface MockPersona {
  name: string;
  flavor: string;
  opening: string;
}

/**
 * Keyless demon brain: scripted replies that echo the player's words and honour the reaction
 * instructions the demon sends itself (greeting, points, kills, hits, summons). Streams word by
 * word so the TTS and interruption paths behave like a real model.
 */
export class MockLLM extends llm.LLM {
  constructor(
    readonly persona: MockPersona,
    readonly playerName: string,
  ) {
    super();
  }

  label(): string {
    return "mock.LLM";
  }

  get model(): string {
    return "scripted";
  }

  get provider(): string {
    return "mock";
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
    return new MockStream(this, { chatCtx, toolCtx, connOptions });
  }
}

class MockStream extends llm.LLMStream {
  private owner: MockLLM;

  constructor(
    owner: MockLLM,
    args: { chatCtx: llm.ChatContext; toolCtx?: llm.ToolContextLike; connOptions: APIConnectOptions },
  ) {
    super(owner, args);
    this.owner = owner;
  }

  protected async run(): Promise<void> {
    const reply = scriptReply(this.chatCtx, this.owner.persona, this.owner.playerName);
    const id = randomUUID();
    for (const word of reply.split(" ")) {
      if (this.abortController.signal.aborted) return;
      this.queue.put({ id, delta: { role: "assistant", content: `${word} ` } });
      await delay(15);
    }
    this.queue.put({
      id,
      usage: { completionTokens: 0, promptTokens: 0, promptCachedTokens: 0, cacheCreationTokens: 0, totalTokens: 0 },
    });
  }
}

const TICS: Record<string, string> = {
  Vexmire: "Sigh.",
  Gib: "HA!",
  "Mother Ash": "Yes, little one.",
  Skreel: "They're listening.",
  "Dr. Malvolio": "ACT TWO!",
  Pebble: "Oh goodie!",
  "The Auditor": "Noted.",
  Rust: "Hm.",
};

const STOP = new Set(
  "a an the i me my we us you your it its is are was were be to of and or but with for in on at that this these make let want some summon give please can could would should just really".split(" "),
);

const pick = <T>(arr: readonly T[], seed: number): T => arr[seed % arr.length]!;

/** The most recent user text and any per-reply instructions issued at or after it. */
function lastTurn(chatCtx: llm.ChatContext): { user: string; instructions: string } {
  let user = "";
  let instructions = "";
  const items = chatCtx.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type !== "message") continue;
    const texts: string[] = [];
    const instr: string[] = [];
    for (const c of item.content) {
      if (typeof c === "string") texts.push(c);
      else if (c && typeof c === "object" && "type" in c && c.type === "instructions") instr.push(c.value);
    }
    // Per-reply instructions arrive either as Instructions content or as a plain system/developer message.
    const system = item.role === "system" || item.role === "developer" ? texts : [];
    if ((instr.length || system.length) && !instructions) instructions = [...instr, ...system].join("\n");
    if (item.role === "user" && texts.length) {
      user = texts.join("\n").trim();
      break;
    }
  }
  return { user, instructions };
}

export function scriptReply(chatCtx: llm.ChatContext, persona: MockPersona, playerName: string): string {
  const { user, instructions } = lastTurn(chatCtx);
  const tic = TICS[persona.name] ?? "";
  const say = (s: string) => `${tic} ${s}`.trim();
  const seed = user.length + instructions.length + chatCtx.items.length;

  if (/opening line/i.test(instructions)) {
    const quoted = /"([^"]{6,})"/.exec(instructions)?.[1];
    return quoted ?? persona.opening;
  }
  const pts = /earned (\d+) points/.exec(instructions);
  if (pts) return say(`${pts[1]} points, ${playerName}. That buys seconds on the human mic. Spend them loudly.`);
  if (/was just destroyed/.test(instructions)) return say(`They broke your thing, ${playerName}. Make something with more teeth.`);
  if (/just hit/.test(instructions)) return say(`Something is biting what you made, ${playerName}. Bite back.`);
  const made = /made "([^"]+)" appear/.exec(instructions);
  if (made) return say(`Look. "${made[1]}" is real now because of your mouth. Keep talking.`);

  if (user.startsWith(UNINTELLIGIBLE_PREFIX)) {
    return say(`I hear your noise, ${playerName}, not your words. No speech key in this dream, so type it to me.`);
  }
  if (!user || user.startsWith("(")) {
    return say(
      pick(
        [`Say something, ${playerName}. The dream is waiting.`, `Quiet summoners get eaten, ${playerName}.`, "Describe one impossible thing. Out loud."],
        seed,
      ),
    );
  }
  const words = user
    .replace(/[^a-z0-9' ]/gi, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()));
  const snippet = words.slice(-4).join(" ") || "that";
  return say(
    pick(
      [
        `${snippet}? Yes. It is already crawling into the dream.`,
        `${snippet}. Fine. Next time make it bigger, ${playerName}.`,
        `Oh, ${snippet}. The other demons will hate that. Good.`,
        `${snippet}. I'll allow it. Now give it something to fight.`,
      ],
      seed,
    ),
  );
}
