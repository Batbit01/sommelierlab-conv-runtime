// src/server.ts
// SommelierLab conv-runtime — Versión corregida y revisada para producción

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import Redis from "ioredis";

console.log("🔥 BOOT server.ts — conv-runtime — stable/v2");

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

if (!N8N_CONTEXT_URL) throw new Error("Missing N8N_CONTEXT_URL");
if (!N8N_CHAT_URL) throw new Error("Missing N8N_CHAT_URL");

/* =======================
   Redis (Configuración robusta)
======================= */

type RedisClient = InstanceType<typeof Redis>;
let redis: RedisClient | null = null;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 0, // No bloquear peticiones si Redis falla
    retryStrategy(times) {
      return times > 3 ? null : Math.min(times * 500, 2000);
    },
  });

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
   Logs Middleware
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
   Healthcheck
======================= */

app.get("/health", async (_req: Request, res: Response) => {
  try {
    if (redis) {
      // Intentamos un ping rápido, si falla no matamos la respuesta
      await redis.set("test:ping", "ok", "EX", 5).catch(() => {});
    }
    res.json({ ok: true, redis: redis ? "configured" : "off" });
  } catch {
    res.json({ ok: true, status: "degraded" });
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

  // Caso A: Token corto (ej: 7XK2)
  if (!code.startsWith("Q")) {
    try {
      if (!N8N_QR_LOOKUP_URL) {
        return res.status(500).send("QR Config Missing");
      }

      const r = await fetch(`${N8N_QR_LOOKUP_URL}?code=${code}`);

      if (!r.ok) {
        return res.status(404).send("invalid QR (n8n)");
      }

      const data = (await r.json()) as QRLookupResponse;

      const vinoId = String(data?.vino_id || "").replace(/[="]/g, "").trim();
      const anyada = String(data?.anyada || "").replace(/[="]/g, "").trim();

      if (!vinoId || vinoId === "undefined" || !anyada) {
        return res.status(404).send("QR data incomplete");
      }

      const vinoIdUpper = vinoId.toUpperCase();
      const redirectUrl = `https://sommelierlab.com/?vino_id=${vinoIdUpper}&anyada=${anyada}`;

      console.log(`[QR] Resolved ${code} -> ${redirectUrl}`);

      // registrar escaneo
      if (N8N_QR_SCAN_URL) {
        fetch(N8N_QR_SCAN_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: code,
            vino_id: vinoIdUpper,
            anyada: anyada,
          }),
        }).catch(() => {});
      }

      return res.redirect(302, redirectUrl);
    } catch (e: any) {
      console.error("[QR] Error:", e?.message ?? String(e));
      return res.status(500).send("Resolver Error");
    }
  }

  // Caso B: Formato largo (ej: Q-V001-2021)
  const parts = code.split("-");

  if (parts.length < 3) {
    return res.status(400).send("invalid code format");
  }

  const vino = parts[1].toUpperCase();
  const anyada = parts[2];

  if (N8N_QR_SCAN_URL) {
    fetch(N8N_QR_SCAN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: code,
        vino_id: vino,
        anyada: anyada,
      }),
    }).catch(() => {});
  }

  return res.redirect(302, `https://sommelierlab.com/?vino_id=${vino}&anyada=${anyada}`);
});

/* =======================
   Chat (Corregido para TypeScript)
======================= */

app.post("/chat", async (req: Request, res: Response) => {
  try {
    if (!redis) throw new Error("Redis not configured");

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

    // AQUÍ LA CORRECCIÓN: Usamos 'as Role' para que TSC no se queje
    const nextState: SessionState = {
      ...state,
      history: [
        ...history, 
        { role: "assistant" as Role, text: assistantText, ts: now() }
      ].slice(-30),
      updated_at: now(),
    };

    await redis.set(sessionKey(session_id), JSON.stringify(nextState), "EX", SESSION_TTL_SECONDS);

    res.json({
      ok: true,
      session_id,
      text: assistantText,
    });
  } catch (e: any) {
    console.error("[CHAT] Error:", e.message);
    res.status(400).json({ ok: false, error: e?.message });
  }
});

/* =======================
   Main
======================= */

app.get("/", (_req: Request, res: Response) => {
  res.send("SommelierLab API v2");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server ready on port ${PORT}`);
});