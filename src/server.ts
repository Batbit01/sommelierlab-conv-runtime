// src/server.ts
// SommelierLab conv-runtime — versión estable (QR resolver limpio + sin duplicados)

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import Redis from "ioredis";

console.log("🔥 BOOT server.ts — conv-runtime — stable");

/* =======================
   Tipos base
======================= */

type Role = "user" | "assistant";

type HistoryItem = {
  role: Role;
  text: string;
  ts: number;
};

type AgentContext = {
  language: string;
  tenant: {
    tenant_id: string;
    bodega?: string | null;
    estilo?: string | null;
    voice_id?: string | null;
  };
  wine: any;
};

type SessionState = {
  agent_context: AgentContext;
  history: HistoryItem[];
  created_at: number;
  updated_at: number;
};

type QRLookupResponse = {
  vino_id?: string;
  anyada?: string;
  tenant_id?: string;
  context?: string;
};

/* =======================
   App
======================= */

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =======================
   ENV
======================= */

const PORT = Number(process.env.PORT || 8080);

const REDIS_URL = process.env.REDIS_URL;
const N8N_CONTEXT_URL = process.env.N8N_CONTEXT_URL;
const N8N_CHAT_URL = process.env.N8N_CHAT_URL;
const N8N_QR_SCAN_URL = process.env.N8N_QR_SCAN_URL;
const N8N_QR_LOOKUP_URL = process.env.N8N_QR_LOOKUP_URL;

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 1800);
const DEBUG_TOKEN = process.env.DEBUG_TOKEN ?? "";

if (!N8N_CONTEXT_URL) throw new Error("Missing N8N_CONTEXT_URL");
if (!N8N_CHAT_URL) throw new Error("Missing N8N_CHAT_URL");

/* =======================
   Redis
======================= */

type RedisClient = InstanceType<typeof Redis>;
let redis: RedisClient | null = null;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    enableReadyCheck: false,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  redis.on("connect", () => console.log("🟢 Redis connected"));
  redis.on("ready", () => console.log("🟢 Redis ready"));
  redis.on("reconnecting", () => console.warn("🟡 Redis reconnecting"));
  redis.on("close", () => console.warn("🟠 Redis connection closed"));
  redis.on("error", (err: Error) => console.error("🔴 Redis error:", err.message));
}

/* =======================
   Utils
======================= */

const sessionKey = (id: string) => `sommelier:session:${id}`;
const now = () => Date.now();

function assertString(name: string, v: unknown): string {
  if (!v || typeof v !== "string" || !v.trim()) throw new Error(`${name} missing`);
  return v.trim();
}

async function httpPostJson<T>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} calling ${url}: ${text}`);
  }

  return (await res.json()) as T;
}

/* =======================
   Logs
======================= */

app.use((req: Request, _res: Response, next: NextFunction) => {
  const rid = Math.random().toString(16).slice(2, 10);
  (req as any).__rid = rid;
  (req as any).__start = now();
  console.log(`[${rid}] --> ${req.method} ${req.url}`);
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  res.on("finish", () => {
    const rid = (req as any).__rid;
    const start = (req as any).__start;
    console.log(`[${rid}] <-- ${req.method} ${req.url} ${res.statusCode} (${now() - start}ms)`);
  });
  next();
});

/* =======================
   Root
======================= */

app.get("/", (_req: Request, res: Response) => {
  res.type("text/plain").send("SommelierLab conv-runtime running");
});

/* =======================
   Healthcheck
======================= */

app.get("/health", async (_req: Request, res: Response) => {
  try {
    if (redis) {
      await redis.connect().catch(() => {});
      await redis.set("test:ping", "ok", "EX", 5).catch(() => {});
    }

    res.json({
      ok: true,
      redis: redis ? "available" : "disabled",
      ttl_seconds: SESSION_TTL_SECONDS,
    });
  } catch {
    res.json({ ok: true, redis: "degraded" });
  }
});

/* =======================
   QR Resolver
======================= */

app.get("/:code", async (req: Request, res: Response, next: NextFunction) => {
  const code = String(req.params.code || "").trim();

  if (!code || code === "health" || code === "session" || code === "chat" || code === "debug") {
    return next();
  }

  if (!code.startsWith("Q")) {
    try {
      if (!N8N_QR_LOOKUP_URL) {
        return res.status(500).send("QR lookup config missing");
      }

      const r = await fetch(`${N8N_QR_LOOKUP_URL}?code=${code}`);

      if (!r.ok) {
        return res.status(404).send("invalid QR");
      }

      const data = (await r.json()) as QRLookupResponse;

      const vinoId = String(data?.vino_id || "").replace("=", "").trim();
      const anyada = String(data?.anyada || "").replace("=", "").trim();

      if (!vinoId || !anyada) {
        return res.status(404).send("invalid QR");
      }

      const redirectUrl = `https://sommelierlab.com/?vino_id=${vinoId}&anyada=${anyada}`;

      console.log("QR resolved:", code, "→", redirectUrl);

      return res.redirect(302, redirectUrl);
    } catch (e) {
      console.error("QR lookup error:", e);
      return res.status(500).send("QR lookup error");
    }
  }

  const parts = code.split("-");

  if (parts.length < 3) {
    return res.status(400).send("invalid code");
  }

  const vino = parts[1].toUpperCase();
  const anyada = parts[2];

  if (process.env.N8N_QR_SCAN_URL) {
    fetch(process.env.N8N_QR_SCAN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: code,
        vino_id: vino,
        anyada,
      }),
    }).catch(() => {});
  }

  const redirectUrl = `https://sommelierlab.com/?vino_id=${vino}&anyada=${anyada}`;

  return res.redirect(302, redirectUrl);
});

/* =======================
   Chat
======================= */

app.post("/chat", async (req: Request, res: Response) => {
  try {
    if (!redis) throw new Error("Redis not available");
    await redis.connect().catch(() => {});

    const session_id = assertString("session_id", req.body.session_id);
    const userText = assertString("userText", req.body.userText);

    const raw = await redis.get(sessionKey(session_id));
    if (!raw) return res.status(404).json({ ok: false, error: "session not found" });

    const state = JSON.parse(raw) as SessionState;

    const history: HistoryItem[] = [
      ...(state.history ?? []),
      { role: "user" as const, text: userText, ts: now() }
    ];

    const chatResp = await httpPostJson<{ ok: boolean; text: string }>(N8N_CHAT_URL!, {
      session_id,
      userText,
      history,
      agent_context: state.agent_context,
    });

    const assistantText = chatResp.text.trim();

    const nextState: SessionState = {
      ...state,
    history: [...history, { role: "assistant" as const, text: assistantText, ts: now() }].slice(-30),
      updated_at: now(),
    };

    await redis.set(sessionKey(session_id), JSON.stringify(nextState), "EX", SESSION_TTL_SECONDS);

    res.json({
      ok: true,
      session_id,
      text: assistantText,
      history_len: nextState.history.length,
    });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/* =======================
   Start
======================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 conv-runtime listening on ${PORT}`);
});