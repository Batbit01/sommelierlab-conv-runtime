// src/server.ts
// SommelierLab conv-runtime — Versión corregida y revisada para producción

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import Redis from "ioredis";
import pg from "pg";

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
const ANALYTICS_DATABASE_URL = process.env.ANALYTICS_DATABASE_URL;

if (!N8N_CONTEXT_URL) throw new Error("Missing N8N_CONTEXT_URL");
if (!N8N_CHAT_URL) throw new Error("Missing N8N_CHAT_URL");

/* =======================
   Postgres analytics
======================= */

const { Pool } = pg;

const analyticsDb = ANALYTICS_DATABASE_URL
  ? new Pool({
      connectionString: ANALYTICS_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

/* =======================
   Redis (Configuración robusta)
======================= */

type RedisClient = InstanceType<typeof Redis>;
let redis: RedisClient | null = null;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
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

function normalizeDbValue(value: any): any {
  if (value === null || value === undefined) return value;

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDbValue);
  }

  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = normalizeDbValue(val);
    }
    return out;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (/^-?\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }

    if (/^-?\d+\.\d+$/.test(trimmed)) {
      return Number.parseFloat(trimmed);
    }
  }

  return value;
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
      await redis.set("test:ping", "ok", "EX", 5).catch(() => {});
    }
    res.json({
      ok: true,
      redis: redis ? "configured" : "off",
      analytics_db: analyticsDb ? "configured" : "off",
    });
  } catch {
    res.json({ ok: true, status: "degraded" });
  }
});

/* =======================
   Debug DB
======================= */

app.get("/debug/db", async (_req: Request, res: Response) => {
  try {
    if (!analyticsDb) {
      return res.status(500).json({
        ok: false,
        error: "ANALYTICS_DATABASE_URL not configured",
      });
    }

    const result = await analyticsDb.query("SELECT NOW() as now");
    return res.json({
      ok: true,
      now: result.rows[0]?.now ?? null,
    });
  } catch (e: any) {
    console.error("[DB] Error:", e?.message ?? String(e));
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "db error",
    });
  }
});

/* =======================
   Analytics Overview
======================= */

app.get("/api/analytics/overview", async (req: Request, res: Response) => {
  try {
    if (!analyticsDb) {
      return res.status(500).json({
        ok: false,
        error: "ANALYTICS_DATABASE_URL not configured",
      });
    }

    const tenant_id = String(req.query.tenant_id || "").trim();
    const monthInput = String(req.query.month || "").trim();

    if (!tenant_id) {
      return res.status(400).json({
        ok: false,
        error: "tenant_id is required",
      });
    }

    const month = /^\d{4}-\d{2}$/.test(monthInput)
      ? `${monthInput}-01`
      : `${new Date().toISOString().slice(0, 7)}-01`;

    const sql = `
      SELECT *
      FROM sommelierlab.analytics_overview_by_tenant_month
      WHERE tenant_id = $1
        AND month = date_trunc('month', $2::date)
      LIMIT 1
    `;

    const result = await analyticsDb.query(sql, [tenant_id, month]);

    return res.json(
      normalizeDbValue({
        ok: true,
        tenant_id,
        month,
        item: result.rows[0] ?? null,
      })
    );
  } catch (e: any) {
    console.error("[ANALYTICS_OVERVIEW] Error:", e?.message ?? String(e));
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "analytics overview error",
    });
  }
});

/* =======================
   Analytics Wines
======================= */

app.get("/api/analytics/wines", async (req: Request, res: Response) => {
  try {
    if (!analyticsDb) {
      return res.status(500).json({
        ok: false,
        error: "ANALYTICS_DATABASE_URL not configured",
      });
    }

    const tenant_id = String(req.query.tenant_id || "").trim();
    const monthInput = String(req.query.month || "").trim();

    if (!tenant_id) {
      return res.status(400).json({
        ok: false,
        error: "tenant_id is required",
      });
    }

    const month = /^\d{4}-\d{2}$/.test(monthInput)
      ? `${monthInput}-01`
      : `${new Date().toISOString().slice(0, 7)}-01`;

    const sql = `
      SELECT *
      FROM sommelierlab.analytics_wine_usage_by_tenant_month
      WHERE tenant_id = $1
        AND month = date_trunc('month', $2::date)
      ORDER BY vino_id ASC
    `;

    const result = await analyticsDb.query(sql, [tenant_id, month]);

    return res.json(
      normalizeDbValue({
        ok: true,
        tenant_id,
        month,
        items: result.rows,
      })
    );
  } catch (e: any) {
    console.error("[ANALYTICS_WINES] Error:", e?.message ?? String(e));
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "analytics wines error",
    });
  }
});

/* =======================
   Analytics Billing
======================= */

app.get("/api/analytics/billing", async (req: Request, res: Response) => {
  try {
    if (!analyticsDb) {
      return res.status(500).json({
        ok: false,
        error: "ANALYTICS_DATABASE_URL not configured",
      });
    }

    const tenant_id = String(req.query.tenant_id || "").trim();
    const monthInput = String(req.query.month || "").trim();

    if (!tenant_id) {
      return res.status(400).json({
        ok: false,
        error: "tenant_id is required",
      });
    }

    const month = /^\d{4}-\d{2}$/.test(monthInput)
      ? `${monthInput}-01`
      : `${new Date().toISOString().slice(0, 7)}-01`;

    const sql = `
      SELECT *
      FROM sommelierlab.analytics_billing_by_tenant_month
      WHERE tenant_id = $1
        AND month = date_trunc('month', $2::date)
      LIMIT 1
    `;

    const result = await analyticsDb.query(sql, [tenant_id, month]);

    return res.json(
      normalizeDbValue({
        ok: true,
        tenant_id,
        month,
        item: result.rows[0] ?? null,
      })
    );
  } catch (e: any) {
    console.error("[ANALYTICS_BILLING] Error:", e?.message ?? String(e));
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "analytics billing error",
    });
  }
});

/* =======================
   Analytics CTA
======================= */

app.get("/api/analytics/cta", async (req: Request, res: Response) => {
  try {
    if (!analyticsDb) {
      return res.status(500).json({
        ok: false,
        error: "ANALYTICS_DATABASE_URL not configured",
      });
    }

    const tenant_id = String(req.query.tenant_id || "").trim();
    const monthInput = String(req.query.month || "").trim();

    if (!tenant_id) {
      return res.status(400).json({
        ok: false,
        error: "tenant_id is required",
      });
    }

    const month = /^\d{4}-\d{2}$/.test(monthInput)
      ? `${monthInput}-01`
      : `${new Date().toISOString().slice(0, 7)}-01`;

    const sql = `
      WITH scoped AS (
        SELECT *
       FROM public.events
        WHERE tenant_id = $1
          AND date_trunc('month', timestamp)::date = date_trunc('month', $2::date)
      )
      SELECT
        $1::text AS tenant_id,
        date_trunc('month', $2::date)::date AS month,
        COUNT(*) FILTER (WHERE event_type = 'cta_click') AS cta_click_count,
        COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'comprar') AS buy_click_count,
        COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'enoturismo') AS enoturismo_click_count,
        COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'reservar_visita') AS reservar_visita_click_count,
        CASE
          WHEN COUNT(*) FILTER (WHERE event_type = 'page_view') > 0
          THEN ROUND(
            (COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'comprar'))::numeric
            / (COUNT(*) FILTER (WHERE event_type = 'page_view')),
            4
          )
          ELSE 0
        END AS page_to_buy_rate,
        CASE
          WHEN COUNT(*) FILTER (WHERE event_type = 'page_view') > 0
          THEN ROUND(
            (COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'enoturismo'))::numeric
            / (COUNT(*) FILTER (WHERE event_type = 'page_view')),
            4
          )
          ELSE 0
        END AS page_to_enoturismo_rate
      FROM scoped
    `;

    const result = await analyticsDb.query(sql, [tenant_id, month]);

    return res.json(
      normalizeDbValue({
        ok: true,
        tenant_id,
        month,
        item: result.rows[0] ?? null,
      })
    );
  } catch (e: any) {
    console.error("[ANALYTICS_CTA] Error:", e?.message ?? String(e));
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "analytics cta error",
    });
  }
});

/* =======================
   Analytics Geo/Lang
======================= */

app.get("/api/analytics/geo-lang", async (req: Request, res: Response) => {
  try {
    if (!analyticsDb) {
      return res.status(500).json({
        ok: false,
        error: "ANALYTICS_DATABASE_URL not configured",
      });
    }

    const tenant_id = String(req.query.tenant_id || "").trim();
    const monthInput = String(req.query.month || "").trim();

    if (!tenant_id) {
      return res.status(400).json({
        ok: false,
        error: "tenant_id is required",
      });
    }

    const month = /^\d{4}-\d{2}$/.test(monthInput)
      ? `${monthInput}-01`
      : `${new Date().toISOString().slice(0, 7)}-01`;

    const byCountrySql = `
      SELECT
        COALESCE(geo_country, 'unknown') AS geo_country,
        COUNT(*) FILTER (WHERE event_type = 'page_view') AS page_view_count,
        COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'comprar') AS buy_click_count,
        COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'enoturismo') AS enoturismo_click_count
      FROM public.events
      WHERE tenant_id = $1
        AND date_trunc('month', timestamp)::date = date_trunc('month', $2::date)
      GROUP BY COALESCE(geo_country, 'unknown')
      ORDER BY page_view_count DESC, buy_click_count DESC
    `;

    const byLangSql = `
      SELECT
        COALESCE(lang, 'unknown') AS lang,
        COUNT(*) FILTER (WHERE event_type = 'page_view') AS page_view_count,
        COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'comprar') AS buy_click_count,
        COUNT(*) FILTER (WHERE event_type = 'cta_click' AND cta_key = 'enoturismo') AS enoturismo_click_count
      FROM public.events
      WHERE tenant_id = $1
        AND date_trunc('month', timestamp)::date = date_trunc('month', $2::date)
      GROUP BY COALESCE(lang, 'unknown')
      ORDER BY page_view_count DESC, buy_click_count DESC
    `;

    const [byCountryResult, byLangResult] = await Promise.all([
      analyticsDb.query(byCountrySql, [tenant_id, month]),
      analyticsDb.query(byLangSql, [tenant_id, month]),
    ]);

    return res.json(
      normalizeDbValue({
        ok: true,
        tenant_id,
        month,
        by_country: byCountryResult.rows,
        by_lang: byLangResult.rows,
      })
    );
  } catch (e: any) {
    console.error("[ANALYTICS_GEO_LANG] Error:", e?.message ?? String(e));
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "analytics geo-lang error",
    });
  }
});

/* =======================
   Chat
======================= */

app.post("/chat", async (req: Request, res: Response) => {
  try {
    if (!redis) throw new Error("Redis not configured");

    const session_id = assertString("session_id", req.body.session_id);
    const userText = assertString("userText", req.body.userText);

    const raw = await redis.get(sessionKey(session_id));
    if (!raw) {
      return res.status(404).json({ ok: false, error: "session not found" });
    }

    const state = JSON.parse(raw) as SessionState;

    const history: HistoryItem[] = [
      ...(state.history ?? []),
      { role: "user" as Role, text: userText, ts: now() },
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
      history: [
        ...history,
        { role: "assistant" as Role, text: assistantText, ts: now() },
      ].slice(-30) as HistoryItem[],
      updated_at: now(),
    };

    await redis.set(sessionKey(session_id), JSON.stringify(nextState), "EX", SESSION_TTL_SECONDS);

    res.json({
      ok: true,
      session_id,
      text: assistantText,
    });
  } catch (e: any) {
    console.error("[CHAT] Error:", e?.message ?? String(e));
    res.status(400).json({ ok: false, error: e?.message ?? "chat error" });
  }
});

/* =======================
   Root
======================= */

app.get("/", (_req: Request, res: Response) => {
  res.send("SommelierLab API v2");
});

/* =======================
   QR Resolver
======================= */

app.get("/:code", async (req: Request, res: Response, next: NextFunction) => {
  const code = String(req.params.code || "").trim();

  if (
    !code ||
    code === "health" ||
    code === "session" ||
    code === "chat" ||
    code === "debug" ||
    code === "db" ||
    code === "api"
  ) {
    return next();
  }

  if (!code.startsWith("Q")) {
    try {
      if (!N8N_QR_LOOKUP_URL) {
        return res.status(500).send("QR Config Missing");
      }

      const r = await fetch(`${N8N_QR_LOOKUP_URL}?code=${encodeURIComponent(code)}`);

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
      const redirectUrl = `https://sommelierlab.com/?vino_id=${encodeURIComponent(vinoIdUpper)}&anyada=${encodeURIComponent(anyada)}`;

      console.log(`[QR] Resolved ${code} -> ${redirectUrl}`);

      if (N8N_QR_SCAN_URL) {
        await fetch(
          `${N8N_QR_SCAN_URL}?token=${encodeURIComponent(code)}&vino_id=${encodeURIComponent(vinoIdUpper)}&anyada=${encodeURIComponent(anyada)}`
        ).catch(() => {});
      }

      return res.redirect(302, redirectUrl);
    } catch (e: any) {
      console.error("[QR] Error:", e?.message ?? String(e));
      return res.status(500).send("Resolver Error");
    }
  }

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
        anyada,
      }),
    }).catch(() => {});
  }

  return res.redirect(
    302,
    `https://sommelierlab.com/?vino_id=${encodeURIComponent(vino)}&anyada=${encodeURIComponent(anyada)}`
  );
});

/* =======================
   Main
======================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server ready on port ${PORT}`);
});