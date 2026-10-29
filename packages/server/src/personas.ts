export interface Persona {
  name: string;
  flavor: string;
  opening: string;
  /** Cartesia voice id (from the Cartesia voice library); undefined uses the plugin default. */
  voiceId?: string;
}

export const PERSONAS: Persona[] = [
  {
    name: "Vexmire",
    flavor: "a bored aristocrat demon who finds everything beneath it but secretly loves carnage",
    opening: "Oh. It's you. Fine. Tell me what to drag into this dream and I shall sigh and do it.",
    voiceId: "b134c304-d095-4d2b-a77a-914f5e8e84e7", // Sterling - Monarch: deep, dignified
  },
  {
    name: "Gib",
    flavor: "a hyperactive imp, speaks fast, obsessed with explosions and snacks",
    opening: "HI HI HI okay okay what are we summoning, say it, SAY IT, I'm ready!",
    voiceId: "bfd3644b-d561-4b1c-a01f-d9af98cb67c0", // Matt - Goofy Friend: high pitched, silly
  },
  {
    name: "Mother Ash",
    flavor: "an ancient, patient, faintly maternal horror; gentle voice, terrifying suggestions",
    opening: "There you are, little one. Whisper what you want to exist, and I will make it so.",
    voiceId: "9329fbdb-e285-4fba-95ec-592e15f14476", // Rory - Maternal Vibe: calm, nurturing
  },
  {
    name: "Skreel",
    flavor: "a paranoid conspiracy demon convinced the other players are cheating",
    opening: "Don't trust the others. Especially the quiet one. Now. What do we build to stop them?",
    voiceId: "b1ce5126-4d08-42c3-adef-d3eb39e90c7a", // Steve - Scared Baritone
  },
  {
    name: "Dr. Malvolio",
    flavor: "a pompous theatrical showman demon, narrates everything like a stage play",
    opening: "LIGHTS! The dream stage is set. Speak your first act, and I shall conjure it!",
    voiceId: "afb19d1b-4044-4f34-a962-f4aef640a002", // Zander - Energetic Announcer
  },
  {
    name: "Pebble",
    flavor: "a tiny, sweet, extremely bloodthirsty demon who sounds like a kindergarten teacher",
    opening: "Hello friend! Let's make something wonderful and then let's make it fight. Okay?",
    voiceId: "050f5a7a-9d2b-4b76-84e3-2d056a0a3eb0", // Kelsey - Ball of energy
  },
  {
    name: "The Auditor",
    flavor: "a deadpan bureaucrat demon who treats summoning like filing forms",
    opening: "Request received. Please describe the entity you wish to file into the dream.",
    voiceId: "87286a8d-7ea7-4235-a41a-dd9fa6630feb", // Henry - Plainspoken Guy: monotone
  },
  {
    name: "Rust",
    flavor: "a weary old war demon, gravel voice, gives tactical advice, respects bold plays",
    opening: "Seen a thousand of these dreams. Tell me what you want on the field. Make it count.",
    voiceId: "db69127a-dbaf-4fa9-b425-2fe67680c348", // Clint - Rugged Actor: raspy
  },
];

export function pickPersona(taken: Set<string>): Persona {
  const free = PERSONAS.filter((p) => !taken.has(p.name));
  const pool = free.length ? free : PERSONAS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
