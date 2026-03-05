// src/server.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import Redis from "ioredis";

console.log("🔥 BOOT server.ts — runtime REAL — 2026-03-05");

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
   App Config
   ======================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =======================
   ENV & Variables
   ======================= */
const PORT = Number(process.env.PORT || 8080);
const REDIS_URL = process.env.REDIS_URL;
const N8N_CONTEXT_URL = process.env.N8N_CONTEXT_URL;
const N8N_CHAT_URL = process.env.N8N_CHAT_URL;
const N8N_QR_SCAN_URL = process.env.N8N_QR_SCAN_URL;
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 1800);
const DEBUG_TOKEN = process.env.DEBUG_TOKEN ?? "";

if (!N8N_CONTEXT_URL) throw new Error("Missing N8N_CONTEXT_URL");
if (!N8N_CHAT_URL) throw new Error("Missing N8N_CHAT_URL");

/* =======================
   Redis Connection
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
  redis.on("error", (err: Error) => console.error("🔴 Redis error:", err.message));
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
   Middlewares (Logs)
   ======================= */
app.use((req: Request, res: Response, next: NextFunction) => {
  const rid = Math.random().toString(16).slice(2, 10);
  (req as any).__rid = rid;
  (req as any).__start = now();

  console.log(`[${rid}] --> ${req.method} ${req.url}`);

  res.on("finish", () => {
    const start = (req as any).__start;
    console.log(`[${rid}] <-- ${req.method} ${req.url} ${res.statusCode} (${now() - start}ms)`);
  });
  next();
});

/* =======================
   Rutas Base
   ======================= */
app.get("/", (_req: Request, res: Response) => {
  res.type("text/plain").send("SommelierLab conv-runtime running");
});

app.get("/health", async (_req: Request, res: Response) => {
  try {
    let redisStatus = "disabled";
    if (redis) {
      await redis.set("test:ping", "ok", "EX", 5);
      redisStatus = "available";
    }
    res.json({
      ok: true,
      redis: redisStatus,
      has_env: {
        REDIS_URL: !!REDIS_URL,
        N8N_CONTEXT_URL: !!N8N_CONTEXT_URL,
        N8N_QR_SCAN_URL: !!N8N_QR_SCAN_URL
      }
    });
  } catch (e) {
    res.json({ ok: true, redis: "degraded" });
  }
});

/* =======================
   QR Resolver (Corregido)
   ======================= */
app.get("/:code", async (req: Request, res: Response, next: NextFunction) => {
  const code = req.params.code;

  // 1. Filtro estricto: Solo rutas que son exactamente iguales a las reservadas
  const reserved = ["health", "session", "chat", "debug", "favicon.ico"];
  if (reserved.includes(code)) return next();
  
  // Si el código es exactamente "qr" (sin nada más), también pasamos
  if (code === "qr") return next();

  try {
    let vino_id: string = "";
    let anyada: string = "";
    let tenant_id: string = "B004";

    // 2. Buscar en Redis (Tokens cortos)
    if (redis && code.length < 12) { // Ampliamos un poco el margen por si acaso
      const cached = await redis.get(`qr:token:${code}`);
      if (cached) {
        const data = JSON.parse(cached);
        vino_id = data.vino_id;
        anyada = data.anyada;
        tenant_id = data.tenant_id || tenant_id;
      }
    }

    // 3. Parsear código largo (soporta Q2-..., qr-..., vino-...)
    if (!vino_id && code.includes("-")) {
      const parts = code.split("-");
      // Buscamos la posición donde esté el vino (normalmente la segunda parte)
      // Ejemplo: qr-v005-2021 -> parts[1] es v005, parts[2] es 2021
      if (parts.length >= 3) {
        vino_id = parts[1].toUpperCase();
        anyada = parts[2];
      }
    }



    // 4. Redirigir
    const redirectUrl = `https://sommelierlab.com/?vino_id=${vino_id}&anyada=${anyada}`;
    return res.redirect(302, redirectUrl);

  } catch (e) {
    console.error("QR Error:", e);
    return res.status(500).send("Internal Error");
  }
});

/* =======================
   Session & Chat
   ======================= */
app.post("/session/init", async (req: Request, res: Response) => {
  try {
    if (!redis) throw new Error("Redis not available");
    const session_id = assertString("session_id", req.body.session_id);
    const vino_id = assertString("vino_id", req.body.vino_id);
    const anyada = assertString("anyada", req.body.anyada);

    const ctxResp = await httpPostJson<{ ok: boolean; agent_context: AgentContext }>(N8N_CONTEXT_URL!, {
      vino_id, anyada, session_id,
      lang: String(req.body.lang ?? "es"),
      tenant_id: String(req.body.tenant_id ?? "default")
    });

    const state: SessionState = {
      agent_context: ctxResp.agent_context,
      history: [],
      created_at: now(),
      updated_at: now()
    };

    await redis.set(sessionKey(session_id), JSON.stringify(state), "EX", SESSION_TTL_SECONDS);
    res.json({ ok: true, session_id, wine_name: state.agent_context.wine?.identidad?.nombre });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/chat", async (req: Request, res: Response) => {
  try {
    if (!redis) throw new Error("Redis not available");
    const session_id = assertString("session_id", req.body.session_id);
    const userText = assertString("userText", req.body.userText);

    const raw = await redis.get(sessionKey(session_id));
    if (!raw) return res.status(404).json({ ok: false, error: "session not found" });

    const state = JSON.parse(raw) as SessionState;
    const history: HistoryItem[] = [...state.history, { role: "user", text: userText, ts: now() }];

    const chatResp = await httpPostJson<{ ok: boolean; text: string }>(N8N_CHAT_URL!, {
      session_id, userText, history, agent_context: state.agent_context
    });

    const assistantText = chatResp.text.trim();
    state.history = [...history, { role: "assistant", text: assistantText, ts: now() }].slice(-30);
    state.updated_at = now();

    await redis.set(sessionKey(session_id), JSON.stringify(state), "EX", SESSION_TTL_SECONDS);
    res.json({ ok: true, text: assistantText });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* =======================
   Start Server
   ======================= */
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 conv-runtime listening on ${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    if (redis) redis.quit().finally(() => process.exit(0));
    else process.exit(0);
  });
});
