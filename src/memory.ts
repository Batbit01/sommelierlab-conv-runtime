import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL;
const TTL = Number(process.env.MEMORY_TTL_SECONDS || 86400);

export type Turn = { role: "user" | "assistant"; text: string; ts: number };

export type MemoryState = {
  sessionId: string;
  tenant_id: string;
  vino_id: string;
  anyada?: string;
  lang: string;
  turns: Turn[];
  summary?: string;
  updatedAt: number;
};

let client: ReturnType<typeof createClient> | null = null;

async function getClient() {
  if (!REDIS_URL) return null;
  if (client) return client;
  client = createClient({ url: REDIS_URL });
  client.on("error", (e) => console.error("❌ Redis error", e));
  await client.connect();
  return client;
}

function key(sessionId: string) {
  return `sl:mem:v1:${sessionId}`;
}

export async function loadMemory(sessionId: string): Promise<MemoryState | null> {
  const c = await getClient();
  if (!c) return null;
  const raw = await c.get(key(sessionId));
  return raw ? (JSON.parse(raw) as MemoryState) : null;
}

export async function saveMemory(state: MemoryState): Promise<void> {
  const c = await getClient();
  if (!c) return;
  await c.set(key(state.sessionId), JSON.stringify(state), { EX: TTL });
}

export function appendTurn(state: MemoryState, turn: Turn, maxTurns = 16) {
  state.turns.push(turn);
  if (state.turns.length > maxTurns) {
    state.turns = state.turns.slice(state.turns.length - maxTurns);
  }
  state.updatedAt = Date.now();
  return state;
}
