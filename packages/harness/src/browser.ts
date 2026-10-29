import { resolve } from "node:path";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import type { WorldState } from "@summoners/shared";
import { api } from "./api.ts";
import { env } from "./env.ts";
import type { Timeline } from "./timeline.ts";

export interface BrowserPlayerOptions {
  room: string;
  name: string;
  timeline: Timeline;
  runDir: string;
  headed?: boolean;
  /** WAV played as the fake microphone once, from page load. */
  wav?: string;
}

interface StoreView {
  players: WorldState["players"];
  entities: WorldState["entities"];
  feed: string[];
  tiles: number;
  /** video elements with decoded frames: proves camera tracks actually flow between browsers */
  videosPlaying: number;
  labels: string[];
  /** remote publications as the client sees them, for diagnosing subscription/permission problems */
  remoteTracks: string[];
  localTracks: string[];
  onRoomMic: boolean;
  level: number;
  talentPoints: number;
  talents: string[];
  /** demon chat panel lines, prefixed demon: / me: / heard: */
  chat: string[];
  /** audio elements with a live stream actually playing: proves the demon's voice reaches the browser */
  audiosPlaying: number;
}

/**
 * Drives the real web client in Chrome with a fake camera and microphone. One browser process per
 * player, because the fake-audio file is a launch flag.
 */
export class BrowserPlayer {
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;
  identity = "";
  sessionKey = "";
  private shots = 0;

  constructor(readonly opts: BrowserPlayerOptions) {}

  private log(kind: string, text: string, data?: unknown) {
    this.opts.timeline.add(kind, text, this.opts.name, data);
  }

  async launch(): Promise<void> {
    const args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
    if (this.opts.wav) args.push(`--use-file-for-fake-audio-capture=${this.opts.wav}%noloop`);
    const launch = { headless: !this.opts.headed, args };
    try {
      this.browser = await chromium.launch({ ...launch, channel: "chrome" });
    } catch {
      this.browser = await chromium.launch(launch); // bundled chromium: npx playwright install chromium
    }
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    await this.context.grantPermissions(["camera", "microphone"], { origin: env.WEB_URL });
    this.page = await this.context.newPage();
    this.page.on("pageerror", (err) => this.log("page-error", err.message));
    this.page.on("console", (msg) => {
      if (msg.type() === "error") this.log("console-error", msg.text().slice(0, 200));
      else if (/^\[(perm|world|key)\]/.test(msg.text())) this.log("console", msg.text().slice(0, 300));
    });
  }

  async join(): Promise<void> {
    await this.page.goto(`${env.WEB_URL}/?room=${encodeURIComponent(this.opts.room)}`);
    await this.page.getByLabel("Your name").fill(this.opts.name);
    await this.page.getByRole("button", { name: "Enter the dream" }).click();
    await this.page.waitForSelector(".mic-button", { timeout: 20_000 });
    const session = await this.page.evaluate(() => JSON.parse(sessionStorage.getItem("summoners.session") ?? "{}") as { identity?: string; sessionKey?: string });
    this.identity = session.identity ?? "";
    this.sessionKey = session.sessionKey ?? "";
    this.log("join", `joined through the UI as ${this.identity}`);
    await this.page.waitForFunction(() => Boolean((window as unknown as { __world?: unknown }).__world), undefined, { timeout: 10_000 });
  }

  async store(): Promise<StoreView> {
    return this.page.evaluate(() => {
      type Store = { getState(): { world: WorldState; feed: { text: string }[] } };
      const s = (window as unknown as { __world: Store }).__world.getState();
      const me = JSON.parse(sessionStorage.getItem("summoners.session") ?? "{}") as { identity?: string };
      return {
        players: s.world.players,
        entities: s.world.entities,
        feed: s.feed.map((f) => f.text),
        tiles: document.querySelectorAll(".tile").length,
        videosPlaying: Array.from(document.querySelectorAll(".tile video")).filter((v) => {
          const el = v as HTMLVideoElement;
          return el.videoWidth > 0 && el.readyState >= 2 && !el.paused;
        }).length,
        labels: Array.from(document.querySelectorAll(".label-name")).map((e) => e.textContent ?? ""),
        localTracks: (() => {
          type Pub = { source: string; trackSid: string };
          const room = (window as unknown as { __room?: { localParticipant: { trackPublications: Map<string, Pub> } } }).__room;
          return room ? Array.from(room.localParticipant.trackPublications.values()).map((t) => `${t.source}:${t.trackSid}`) : [];
        })(),
        remoteTracks: (() => {
          type Pub = { source: string; kind: string; isSubscribed: boolean; track?: unknown; subscriptionStatus?: string; permissionStatus?: string };
          type Part = { identity: string; trackPublications: Map<string, Pub> };
          const room = (window as unknown as { __room?: { remoteParticipants: Map<string, Part> } }).__room;
          if (!room) return [];
          return Array.from(room.remoteParticipants.values()).flatMap((p) =>
            Array.from(p.trackPublications.values()).map((t) => `${p.identity}/${t.source}: subscribed=${t.isSubscribed} track=${Boolean(t.track)} ${t.subscriptionStatus ?? ""} ${t.permissionStatus ?? ""}`),
          );
        })(),
        onRoomMic: Boolean(me.identity && s.world.players[me.identity]?.onRoomMic),
        level: (me.identity && s.world.players[me.identity]?.level) || 1,
        talentPoints: (me.identity && s.world.players[me.identity]?.talentPoints) || 0,
        talents: (me.identity && s.world.players[me.identity]?.talents) || [],
        chat: (() => {
          type Chat = { getState(): { lines: { identity: string; text: string; final: boolean }[] } };
          const chat = (window as unknown as { __chat?: Chat }).__chat;
          if (!chat) return [];
          const demonId = me.identity ? s.world.players[me.identity]?.demonIdentity : null;
          return chat
            .getState()
            .lines.filter((l) => l.final)
            .map(
              (l) =>
                `${l.identity === demonId ? "demon" : l.identity === "typed" ? "me" : l.identity === me.identity ? "heard" : "other-demon"}:${l.text}`,
            );
        })(),
        audiosPlaying: Array.from(document.querySelectorAll("audio")).filter((a) => a.srcObject && !a.paused && a.readyState >= 2).length,
      };
    });
  }

  /** Open the talent tree and take the first available talent, if any. Returns its id. */
  async takeTalent(): Promise<string | null> {
    await this.page.locator(".talents-toggle").click();
    await this.page.waitForSelector(".talents-panel", { timeout: 5000 });
    const btn = this.page.locator(".talent.available").first();
    if ((await btn.count()) === 0) {
      this.log("talent", "talent tree open, nothing affordable");
      return null;
    }
    const id = await btn.getAttribute("data-talent");
    await btn.click();
    this.log("talent", `took ${id} in the UI`);
    return id;
  }

  /** Type to the demon through the chat box in the UI. */
  async whisper(text: string): Promise<void> {
    this.log("whisper", `(typed in the UI) "${text}"`);
    const input = this.page.locator(".demon-chat-input");
    await input.fill(text);
    await input.press("Enter");
  }

  /** Speech without audio: injected as a transcript, exactly what the demon would forward. */
  async say(text: string): Promise<void> {
    this.log("say", `"${text}"`);
    await api.transcript(this.opts.room, this.identity, text);
  }

  async holdMic(seconds: number): Promise<void> {
    this.log("hold-mic", `holding the room mic button for ${seconds}s`);
    const btn = this.page.locator(".mic-button");
    await btn.dispatchEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true });
    await this.page.waitForTimeout(seconds * 1000);
    await btn.dispatchEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true });
    this.log("release-mic", "released the room mic button");
  }

  async screenshot(label: string): Promise<string> {
    const path = resolve(this.opts.runDir, `${this.opts.name}-${String(++this.shots).padStart(2, "0")}-${label}.png`);
    await this.page.screenshot({ path });
    this.log("screenshot", path);
    return path;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }
}
