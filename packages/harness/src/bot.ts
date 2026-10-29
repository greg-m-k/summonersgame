import { resolve } from "node:path";
import {
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import {
  PositionsPacket,
  SecretMessage,
  TEAM_INFO,
  TOPIC_CHAT,
  TOPIC_POSITIONS,
  TOPIC_SECRET,
  emptyWorld,
  TOPIC_WORLD,
  WorldEvent,
  WorldState,
  applyEvent,
  decode,
} from "@summoners/shared";
import { type Session, api } from "./api.ts";
import { Recorder, readWav, tone } from "./audio.ts";
import { FakeMic } from "./fakemic.ts";
import { type Entry, Timeline } from "./timeline.ts";
import { synthesize } from "./tts.ts";

export interface BotOptions {
  room: string;
  name: string;
  timeline: Timeline;
  /** Speak through real audio (TTS -> mic track -> demon) instead of injecting transcripts. */
  voice?: boolean;
  /** Which Windows voice to use in voice mode. */
  voiceIndex?: number;
  /** Save what the demon said as WAV into this directory. */
  recordDir?: string;
  /** Only one bot per run logs shared world events, so the timeline is not duplicated per player. */
  reporter?: boolean;
}

/**
 * A synthetic player: joins through the real API, connects to the real LiveKit room, mirrors the
 * world from the data channel, listens to its demon (audio frames and transcription text), can speak
 * (transcript injection or TTS audio), and can hold the room mic.
 */
export class Bot {
  readonly room = new Room();
  readonly timeline: Timeline;
  readonly name: string;
  readonly roomName: string;
  session!: Session;
  world: WorldState;
  demonIdentity: string | null = null;
  demonSaid: string[] = [];
  demonHeard: string[] = [];
  /** Pipeline stages the demon reported as keyless mocks ("stt", "llm", "tts"). */
  demonMocks: string[] = [];
  demonFrames = 0;
  /** Private deals my demon offered me. */
  secrets: string[] = [];
  /** Swings the combat engine made on its own, seen on the data channel. */
  autoHits = 0;
  private demonSegments = new Set<string>();
  private fightPairs = new Set<string>();
  private demonRecorder: Recorder | null = null;
  private listening = new Set<string>();
  private heardCount = new Map<string, number>();
  private mic: FakeMic | null = null;
  private opts: BotOptions;
  private micPublished = false;
  private leaving = false;
  private micRequests = 0;

  constructor(opts: BotOptions) {
    this.opts = opts;
    this.timeline = opts.timeline;
    this.name = opts.name;
    this.roomName = opts.room;
    this.world = emptyWorld(opts.room);
  }

  get identity(): string {
    return this.session.identity;
  }

  get me() {
    return this.world.players[this.identity];
  }

  log(kind: string, text: string, data?: unknown): Entry {
    return this.timeline.add(kind, text, this.name, data);
  }

  async join(): Promise<void> {
    this.session = await api.join(this.roomName, this.name);
    this.log("join", `joined as ${this.session.identity}, demon persona ${this.session.persona}`);
    this.wire();
    await this.room.connect(this.session.url, this.session.token, { autoSubscribe: false, dynacast: false });
    this.log("connect", `connected to LiveKit room ${this.roomName}`);
    const meta = this.room.metadata;
    if (meta) this.adoptSnapshot(meta);
    // The metadata snapshot is debounced on the server; fetch the world now so player names and
    // banks are known before the first event lands.
    await this.refreshWorld().catch(() => {});
    // Always publish a mic track (silence when idle) so subscription gating can be exercised.
    this.mic = new FakeMic(16000);
    const track = LocalAudioTrack.createAudioTrack("mic", this.mic.source);
    await this.room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    this.micPublished = true;
    for (const p of this.room.remoteParticipants.values()) this.considerParticipant(p);
  }

  private wire(): void {
    this.room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
      if (topic === TOPIC_WORLD) {
        const ev = WorldEvent.safeParse(decode(payload));
        if (!ev.success) {
          this.log("bad-event", `world event failed to parse: ${ev.error.issues[0]?.path.join(".")} ${ev.error.issues[0]?.message}`);
          return;
        }
        this.world = applyEvent(this.world, ev.data);
        this.describe(ev.data);
      } else if (topic === TOPIC_POSITIONS) {
        const p = PositionsPacket.safeParse(decode(payload));
        if (p.success) this.log("positions", `${p.data.items.length} entities moved`, p.data);
      } else if (topic === TOPIC_SECRET) {
        const m = SecretMessage.safeParse(decode(payload));
        if (!m.success) return;
        if (m.data.type === "temptation") {
          this.secrets.push(m.data.text);
          this.log("secret", `my demon offers a deal: ${m.data.text} (+${m.data.rewardSeconds}s)`);
        } else this.log("secret", `deal ${m.data.success ? "done" : "lost"}: ${m.data.text}`);
      }
    });
    this.room.on(RoomEvent.RoomMetadataChanged, (metadata) => this.adoptSnapshot(metadata));
    this.room.on(RoomEvent.ParticipantConnected, (p) => this.considerParticipant(p));
    this.room.on(RoomEvent.ParticipantAttributesChanged, (_attrs, p) => {
      if (p.identity !== this.room.localParticipant?.identity) this.considerParticipant(p as RemoteParticipant);
    });
    this.room.on(RoomEvent.TrackPublished, (pub, p) => this.considerTrack(pub, p));
    this.room.on(RoomEvent.TrackSubscribed, (track, pub, p) => this.onSubscribed(track, pub, p));
    this.room.on(RoomEvent.TrackSubscriptionFailed, (sid, p, reason) =>
      this.log("subscribe-failed", `could not subscribe to ${p.identity} ${sid}: ${reason ?? "?"}`),
    );
    this.room.on(RoomEvent.Disconnected, (reason) => {
      if (!this.leaving) this.log("disconnect", `disconnected unexpectedly: ${String(reason)}`);
    });
    // Two shapes on this topic: the demon's own speech is one delta stream per segment (attribute
    // lk.transcription_final stays "false", the stream closes when playout ends); what the demon heard
    // arrives as interim streams plus one final stream (lk.transcription_final "true"), same segment id.
    this.room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
      const attrs = reader.info.attributes ?? {};
      const segment = attrs["lk.segment_id"] ?? reader.info.streamId;
      const final = attrs["lk.transcription_final"] === "true";
      let text = "";
      try {
        text = (await reader.readAll()).trim();
      } catch {
        return; // stream cut by a disconnect (ours or the demon's); nothing to record
      }
      if (!text) return;
      if (info.identity === this.demonIdentity) {
        if (this.demonSegments.has(segment)) return;
        this.demonSegments.add(segment);
        this.demonSaid.push(text);
        this.log("demon-said", text);
      } else if (info.identity === this.identity && final) {
        this.demonHeard.push(text);
        this.log("demon-heard", text);
      }
    });
    // Agent session telemetry streams are not for us; a handler keeps rtc-node from logging every chunk.
    this.room.registerByteStreamHandler("lk.agent.session", () => {});
  }

  private adoptSnapshot(metadata: string): void {
    try {
      const parsed = WorldState.safeParse(JSON.parse(metadata));
      if (parsed.success) this.world = parsed.data;
      else this.log("bad-snapshot", `room snapshot failed to parse: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    } catch {
      // not ours
    }
  }

  private describe(ev: WorldEvent): void {
    if (ev.type === "player_updated") return this.trackDemon(ev);
    if (ev.type === "mic_time") this.onMicTime(ev.playerId, ev.on);
    if (ev.type === "attack" && ev.auto) this.autoHits++;
    if (!this.opts.reporter) return;
    const name = (id: string) => this.world.players[id]?.name ?? id;
    const label = (id: string) => this.world.entities[id]?.label ?? id;
    switch (ev.type) {
      case "summon":
        this.log("summon", `${name(ev.entity.ownerId)} -> "${ev.entity.label}" (hp ${ev.entity.hp}, atk ${ev.entity.attack}, size ${ev.entity.size}, fx ${ev.entity.fx})`, ev);
        break;
      case "entity_image":
        this.log("image", `${label(ev.entityId)} got its picture`, ev);
        break;
      case "attack": {
        if (!ev.auto) {
          this.log("attack", `${label(ev.attackerId)} hits ${label(ev.targetId)} for ${ev.damage} (${ev.targetHp} hp left): ${ev.flavor}`, ev);
          break;
        }
        // The engine swings about once a second per creature; log the first swing of each pairing.
        const key = `${ev.attackerId}>${ev.targetId}`;
        if (!this.fightPairs.has(key)) {
          this.fightPairs.add(key);
          this.log("fight", `${label(ev.attackerId)} engages ${label(ev.targetId)} on its own (${ev.targetHp} hp left after ${ev.damage})`, ev);
        }
        break;
      }
      case "level_up":
        this.log("level", `${name(ev.playerId)} reaches level ${ev.level} (${ev.talentPoints} talent point(s), bank ${ev.micBank}s)`, ev);
        break;
      case "talent":
        this.log("talent", `${name(ev.playerId)} takes ${ev.talentId} (${ev.talentPoints} left)`, ev);
        break;
      case "match_started":
        this.log("match", `match ${ev.match.number} begins: hearts ${ev.hearts.map((h) => `${h.label} ${h.hp}`).join(", ")}`, ev);
        break;
      case "match_over":
        this.log(
          "match",
          `match ${ev.match.number} over: ${ev.winner ? `team ${TEAM_INFO[ev.winner].name} wins` : "no winner"}; bribes ${JSON.stringify(ev.bribes)}`,
          ev,
        );
        break;
      case "destroy":
        this.log("destroy", `${label(ev.entityId)} destroyed: ${ev.cause}`, ev);
        break;
      case "transform":
        this.log("transform", `${ev.entity.label}: ${ev.description}`, ev);
        break;
      case "warp_world":
        this.log("warp", `${ev.description} (mood "${ev.environment.mood}")`, ev);
        break;
      case "narrate":
        this.log("narrate", ev.text);
        break;
      case "points":
        this.log("points", `+${ev.points} ${name(ev.playerId)} (${ev.reason}) -> score ${ev.score}, bank ${ev.micBank}s`, ev);
        break;
      case "mic_time":
        this.log("mic", `${name(ev.playerId)} room mic ${ev.on ? "ON" : "off"}, bank ${ev.micBank}s`, ev);
        break;
      case "player_joined":
        this.log("player", `${ev.player.name} joined with ${ev.player.persona}`);
        break;
      case "player_left":
        this.log("player", `${name(ev.playerId)} left`);
        break;
    }
  }

  private trackDemon(ev: Extract<WorldEvent, { type: "player_updated" }>): void {
    if (ev.player.identity === this.identity && ev.player.demonIdentity && ev.player.demonIdentity !== this.demonIdentity) {
      this.demonIdentity = ev.player.demonIdentity;
      this.log("demon", `my demon is ${this.demonIdentity}`);
      for (const p of this.room.remoteParticipants.values()) this.considerParticipant(p);
    }
  }

  private considerParticipant(p: RemoteParticipant): void {
    if (p.attributes?.demon_for === this.identity && this.demonIdentity !== p.identity) {
      this.demonIdentity = p.identity;
      this.demonMocks = (p.attributes.mocks ?? "").split(",").filter(Boolean);
      this.log("demon", `my demon ${p.attributes.persona ?? "?"} is in the room as ${p.identity}${this.demonMocks.length ? ` (mocks: ${this.demonMocks.join(", ")})` : ""}`);
    }
    for (const pub of p.trackPublications.values()) this.considerTrack(pub, p);
  }

  private wantsTrack(pub: RemoteTrackPublication, p: RemoteParticipant): boolean {
    if (pub.kind !== TrackKind.KIND_AUDIO) return false;
    if (p.kind === ParticipantKind.AGENT || p.attributes?.demon_for) return p.identity === this.demonIdentity;
    return this.listening.has(p.identity);
  }

  private considerTrack(pub: RemoteTrackPublication, p: RemoteParticipant): void {
    const want = this.wantsTrack(pub, p);
    if (want && !pub.subscribed) pub.setSubscribed(true);
    else if (!want && pub.subscribed) pub.setSubscribed(false);
  }

  private onSubscribed(track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant): void {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    const isDemon = p.identity === this.demonIdentity;
    this.log("subscribed", `now hearing ${isDemon ? "my demon" : p.identity}`);
    const stream = new AudioStream(track, 16000, 1);
    if (isDemon && this.opts.recordDir) this.demonRecorder = new Recorder(16000);
    void (async () => {
      const reader = stream.getReader();
      while (true) {
        const { done, value: frame } = await reader.read();
        if (done || !frame) break;
        if (isDemon) {
          this.demonFrames++;
          this.demonRecorder?.push(frame);
        } else {
          // count only non-silent frames so a muted/silent track does not count as "heard"
          let energy = 0;
          for (let i = 0; i < frame.data.length; i += 16) energy += Math.abs(frame.data[i]!);
          if (energy > 0) this.heardCount.set(p.identity, (this.heardCount.get(p.identity) ?? 0) + 1);
        }
      }
    })();
  }

  /** Other humans' mics are subscribed only while the server says they are on the room mic. */
  private onMicTime(playerId: string, on: boolean): void {
    if (playerId === this.identity) return;
    if (on) this.listening.add(playerId);
    else this.listening.delete(playerId);
    const p = [...this.room.remoteParticipants.values()].find((x) => x.identity === playerId);
    if (p) for (const pub of p.trackPublications.values()) this.considerTrack(pub, p);
  }

  /** Non-silent frames received from another human's mic so far. */
  heard(identity: string): number {
    return this.heardCount.get(identity) ?? 0;
  }

  /** Say something to the demon: real audio in voice mode, otherwise injected as a final transcript. */
  async say(text: string): Promise<void> {
    if (this.opts.voice) {
      if (!this.mic || !this.micPublished) throw new Error("mic not published");
      const wav = synthesize(text, this.opts.voiceIndex ?? 0);
      this.log("say", `(voice) "${text}"`);
      const pcm = readWav(wav);
      await this.mic.play(pcm);
      return;
    }
    this.log("say", `"${text}"`);
    await api.transcript(this.roomName, this.identity, text);
  }

  /** Type to the demon on the agents framework's chat topic: it answers, and forwards the text to the game master. */
  async whisper(text: string): Promise<void> {
    this.log("whisper", `(typed) "${text}"`);
    await this.room.localParticipant!.sendText(text, { topic: TOPIC_CHAT });
  }

  /** Speak a clip of raw audio through the mic track, e.g. a pre-made WAV. */
  async playWav(path: string): Promise<void> {
    if (!this.mic) throw new Error("mic not published");
    this.log("say", `(wav) ${path}`);
    await this.mic.play(readWav(path));
  }

  /** Put a sine tone on the mic track so listeners can prove they receive audio. */
  async playTone(seconds: number): Promise<void> {
    if (!this.mic) throw new Error("mic not published");
    this.log("tone", `${seconds}s test tone on my mic`);
    await this.mic.play(tone(seconds, this.mic.sampleRate));
  }

  async holdMic(seconds: number): Promise<{ ok: boolean; reason?: string }> {
    this.micRequests++;
    const r = await api.mic(this.session, true);
    this.log("hold-mic", r.ok ? `holding room mic for ${seconds}s` : `room mic refused: ${r.reason}`);
    if (!r.ok) return r;
    await sleep(seconds * 1000);
    await api.mic(this.session, false);
    this.log("release-mic", "released room mic");
    return { ok: true };
  }

  async waitForDemon(timeoutMs = 30_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.demonIdentity && this.demonFrames > 0) return true;
      await sleep(250);
    }
    return Boolean(this.demonIdentity);
  }

  /** Wait for a timeline entry of these kinds produced after `since` (ms); optional text filter. */
  waitFor(kinds: string[], timeoutMs: number, since = this.timeline.now(), pred?: (e: Entry) => boolean): Promise<Entry | null> {
    return this.timeline.waitFor((e) => kinds.includes(e.kind) && (!pred || pred(e)), timeoutMs, since);
  }

  myEntities() {
    return Object.values(this.world.entities).filter((e) => e.ownerId === this.identity);
  }

  async refreshWorld(): Promise<WorldState> {
    this.world = await api.state(this.roomName);
    return this.world;
  }

  async leave(): Promise<{ demonAudioSeconds: number }> {
    this.leaving = true;
    let demonAudioSeconds = 0;
    if (this.demonRecorder && this.opts.recordDir) {
      demonAudioSeconds = this.demonRecorder.save(resolve(this.opts.recordDir, `${this.name}-demon.wav`));
    }
    await this.mic?.stop().catch(() => {});
    await this.room.disconnect().catch(() => {});
    this.log("leave", `left (demon frames ${this.demonFrames}, demon lines ${this.demonSaid.length})`);
    return { demonAudioSeconds };
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
