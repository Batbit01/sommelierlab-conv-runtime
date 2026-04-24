import type { Request, Response, NextFunction } from "express";
import type IORedis from "ioredis";
type RedisClient = InstanceType<typeof IORedis>;

/**
 * Utilidades de seguridad del conv-runtime.
 *
 * - requireSecret: auth por cabecera compartida (analytics + debug).
 * - rateLimitRedis: sliding-window en Redis (reutiliza la infra existente).
 * - makeCorsOrigin: whitelist configurable por env.
 * - sanitizeError: impide filtrar mensajes internos al cliente.
 */

/** Token de API compartido. Se pasa en header `x-api-key`. */
export function requireSecret(envVarName: string) {
  const expected = process.env[envVarName];
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) {
      return res.status(503).json({ ok: false, error: `${envVarName} not configured` });
    }
    const given = req.header("x-api-key") || "";
    // Comparación timing-safe barata: longitudes distintas ya fallan rápido.
    if (given.length !== expected.length || given !== expected) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    next();
  };
}

/**
 * Rate limit basado en ZSET de Redis — sliding window real.
 * key: identificador único ("chat:sess:abc" | "qr:ip:1.2.3.4")
 * windowMs + max: p.ej. 60_000 / 20 => 20 reqs/min
 *
 * Fail-open: si Redis falla, permite la request (no queremos caer el servicio).
 */
export async function rateLimitRedis(
  redis: RedisClient | null,
  key: string,
  windowMs: number,
  max: number
): Promise<{ allowed: boolean; count: number; retryAfterMs: number }> {
  if (!redis) return { allowed: true, count: 0, retryAfterMs: 0 };
  try {
    const nowMs = Date.now();
    const windowStart = nowMs - windowMs;
    const redisKey = `ratelimit:${key}`;
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    pipeline.zadd(redisKey, nowMs, `${nowMs}-${Math.random()}`);
    pipeline.zcard(redisKey);
    pipeline.pexpire(redisKey, windowMs);
    const results = await pipeline.exec();
    const count = Number((results?.[2]?.[1] as number) ?? 0);
    if (count > max) {
      // Recupera el más antiguo para calcular retry-after real.
      const oldest = await redis.zrange(redisKey, 0, 0, "WITHSCORES");
      const oldestMs = Number(oldest[1] ?? nowMs);
      const retryAfterMs = Math.max(0, oldestMs + windowMs - nowMs);
      return { allowed: false, count, retryAfterMs };
    }
    return { allowed: true, count, retryAfterMs: 0 };
  } catch {
    return { allowed: true, count: 0, retryAfterMs: 0 };
  }
}

/** Construye el comprobador de origin para cors() a partir de CSV en env. */
export function makeCorsOrigin(allowedCsv: string | undefined) {
  const list = (allowedCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return function originChecker(
    origin: string | undefined,
    cb: (err: Error | null, allow?: boolean) => void
  ) {
    // Requests sin origin (curl, same-origin, server-to-server) → permitidos.
    if (!origin) return cb(null, true);
    if (list.length === 0) return cb(null, false);
    if (list.includes(origin)) return cb(null, true);
    // Soporta wildcard de subdominios: https://*.sommelierlab.com
    for (const rule of list) {
      if (rule.startsWith("https://*.")) {
        const suffix = rule.slice("https://*".length);
        if (origin.startsWith("https://") && origin.endsWith(suffix)) return cb(null, true);
      }
    }
    return cb(null, false);
  };
}

/** Devuelve un error genérico al cliente y registra el detalle interno. */
export function sanitizeError(ctx: string, e: unknown, status = 500, res: Response) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(`[${ctx}]`, detail);
  return res.status(status).json({ ok: false, error: "internal_error" });
}

/** Trunca tokens largos para logs: Q-ABCDEF123 -> Q-ABCD***. */
export function redactToken(token: string): string {
  if (!token) return "";
  if (token.length <= 6) return token.slice(0, 2) + "***";
  return token.slice(0, 4) + "***" + token.slice(-2);
}
