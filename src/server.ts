// src/server.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import Redis from "ioredis";
console.log("🔥 BOOT server.ts — runtime REAL — 2026-01-08");


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

/* =======================
   App
======================= */

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/**
 * ⚠️ Railway
 * - PORT debe venir de env
 * - fallback 8080
 */
const PORT = Number(process.env.PORT || 8080);

const REDIS_URL = process.env.REDIS_URL;
const N8N_CONTEXT_URL = process.env.N8N_CONTEXT_URL;
const N8N_CHAT_URL = process.env.N8N_CHAT_URL;
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 1800);
const DEBUG_TOKEN = process.env.DEBUG_TOKEN ?? "";

/**
 * ❗ No tiramos el proceso por Redis.
 * Railway mata contenedores que crashean al boot.
 */
if (!N8N_CONTEXT_URL) throw new Error("Missing N8N_CONTEXT_URL");
if (!N8N_CHAT_URL) throw new Error("Missing N8N_CHAT_URL");

/* =======================
   Redis (BLINDADO + LAZY)
======================= */

// ✅ FIX TS2709: tipo correcto para ioredis en TS/ESM
type RedisClient = InstanceType<typeof Redis>;

let redis: RedisClient | null = null;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    lazyConnect: true, // ⬅️ CLAVE
    enableReadyCheck: false, // ⬅️ CLAVE
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  redis.on("connect", () => console.log("🟢 Redis connected"));
  redis.on("ready", () => console.log("🟢 Redis ready"));
  redis.on("reconnecting", () => console.warn("🟡 Redis reconnecting"));
  redis.on("close", () => console.warn("🟠 Redis connection closed"));

  // ✅ FIX TS7006: tipado explícito
  redis.on("error", (err: Error) =>
    console.error("🔴 Redis error (handled):", err.message)
  );
}

/* =======================
   Utils
======================= */

const sessionKey = (id: string) => `sommelier:session:${id}`;
const now = () => Date.now();

function assertString(name: string, v: unknown): string {
  if (!v || typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} missing`);
  }
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
   Logs middleware
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
    console.log(
      `[${rid}] <-- ${req.method} ${req.url} ${res.statusCode} (${now() - start}ms)`
    );
  });
  next();
});

/* =======================
   Routes
======================= */

app.get("/", (_req: Request, res: Response) => {
  res.type("text/plain").send("SommelierLab conv-runtime running");
});

/**
 * Healthcheck Railway-safe
 * ❗ NUNCA rompe el servicio
 */
app.get("/health", async (_req: Request, res: Response) => {
  try {
    if (redis) {
      // lazyConnect -> conectamos bajo demanda
      await redis.connect().catch(() => {});
      await redis.set("test:ping", "ok", "EX", 5).catch(() => {});
    }

    res.json({
      ok: true,
      redis: redis ? "available" : "disabled",
      ttl_seconds: SESSION_TTL_SECONDS,
      has_env: {
        REDIS_URL: !!REDIS_URL,
        N8N_CONTEXT_URL: !!N8N_CONTEXT_URL,
        N8N_CHAT_URL: !!N8N_CHAT_URL,
      },
    });
  } catch {
    res.json({ ok: true, redis: "degraded" });
  }
});

/* =======================
   Session init
======================= */

app.post("/session/init", async (req: Request, res: Response) => {
  try {
    if (!redis) throw new Error("Redis not available");
    await redis.connect().catch(() => {}); // asegura conexión

    const session_id = assertString("session_id", req.body.session_id);
    const vino_id = assertString("vino_id", req.body.vino_id);
    const anyada = assertString("anyada", req.body.anyada);
    const lang = String(req.body.lang ?? "es").toLowerCase();
    const tenant_id = String(req.body.tenant_id ?? "default");

    const ctxResp = await httpPostJson<{
      ok: boolean;
      agent_context: AgentContext;
    }>(N8N_CONTEXT_URL!, {
      vino_id,
      anyada,
      lang,
      tenant_id,
      session_id,
    });

    if (!ctxResp?.agent_context) {
      throw new Error("n8n context missing agent_context");
    }

    const state: SessionState = {
      agent_context: ctxResp.agent_context,
      history: [],
      created_at: now(),
      updated_at: now(),
    };

    await redis.set(
      sessionKey(session_id),
      JSON.stringify(state),
      "EX",
      SESSION_TTL_SECONDS
    );

    res.json({
      ok: true,
      session_id,
      ttl_seconds: SESSION_TTL_SECONDS,
      language: state.agent_context.language,
      tenant: state.agent_context.tenant?.tenant_id,
      wine_name: state.agent_context.wine?.identidad?.nombre ?? null,
    });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/* =======================
   Chat
======================= */

app.post("/chat", async (req: Request, res: Response) => {
  try {
    if (!redis) throw new Error("Redis not available");
    await redis.connect().catch(() => {}); // asegura conexión

    const session_id = assertString("session_id", req.body.session_id);
    const userText = assertString("userText", req.body.userText);

    const raw = await redis.get(sessionKey(session_id));
    if (!raw) {
      return res.status(404).json({ ok: false, error: "session not found" });
    }

    const state = JSON.parse(raw) as SessionState;

    const history: HistoryItem[] = [
      ...(state.history ?? []),
      // ✅ FIX TS2322: literal narrow
      { role: "user" as Role, text: userText, ts: now() },
    ];

    const chatResp = await httpPostJson<{ ok: boolean; text: string }>(
      N8N_CHAT_URL!,
      {
        session_id,
        userText,
        history,
        agent_context: state.agent_context,
      }
    );

    if (!chatResp?.text) {
      throw new Error("n8n chat missing text");
    }

    const assistantText = chatResp.text.trim();

    const nextState: SessionState = {
      ...state,
      history: [
        ...history,
        // ✅ FIX TS2322: literal narrow
        { role: "assistant" as Role, text: assistantText, ts: now() },
      ].slice(-30),
      updated_at: now(),
    };

    await redis.set(
      sessionKey(session_id),
      JSON.stringify(nextState),
      "EX",
      SESSION_TTL_SECONDS
    );

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
   Debug
======================= */

app.get("/debug/session/:id", async (req: Request, res: Response) => {
  try {
    if (!redis) throw new Error("Redis not available");
    await redis.connect().catch(() => {}); // asegura conexión

    const token = String(req.query.token ?? "");
    if (DEBUG_TOKEN && token !== DEBUG_TOKEN) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const key = sessionKey(req.params.id);
    const raw = await redis.get(key);
    const ttl = await redis.ttl(key);

    res.json({
      ok: true,
      exists: !!raw,
      ttl_seconds: ttl,
      state: raw ? JSON.parse(raw) : null,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/* =======================
   Start / Shutdown
======================= */

/**
 * ⬅️ CRÍTICO PARA RAILWAY
 */
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 conv-runtime listening on ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down cleanly...");
  server.close(() => {
    if (redis) {
      redis.quit().finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
});
