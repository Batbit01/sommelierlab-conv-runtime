// src/server.ts

import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/**
 * SommelierLab Conversational Runtime
 * WS Protocol v1 (FINAL)
 */

const PORT: number = Number(process.env.PORT) || 3000;

/* ----------------------------- Types ----------------------------- */

type Lang = "es" | "en" | "fr" | "de" | "it" | "pt" | "ca" | string;

type WSMessageBase = {
  v: 1;
  type: string;
  sessionId: string;
  ts?: number;
};

type PingMsg = WSMessageBase & { type: "ping" };

type SessionStartMsg = WSMessageBase & {
  type: "session.start";
  lang: Lang;
  vino_id: string;
  context?: Record<string, unknown>;
};

type UserMessageMsg = WSMessageBase & {
  type: "user.message";
  text: string;
};

type ClientToServer = PingMsg | SessionStartMsg | UserMessageMsg;

type ServerToClient =
  | (WSMessageBase & { type: "pong" })
  | (WSMessageBase & {
      type: "session.ready";
      capabilities: { text: boolean; audio: boolean; streaming: boolean };
    })
  | (WSMessageBase & { type: "assistant.thinking" })
  | (WSMessageBase & { type: "assistant.chunk"; delta: string })
  | (WSMessageBase & {
      type: "assistant.message";
      text: string;
      meta?: { confidence?: number; source?: string };
    })
  | (WSMessageBase & { type: "error"; code: string; message: string });

/* --------------------------- Session --------------------------- */

type SessionState = {
  sessionId: string;
  lang?: Lang;
  vino_id?: string;
  context?: Record<string, unknown>;
  createdAt: number;
  lastSeenAt: number;
};

const sessions = new Map<string, SessionState>();

function upsertSession(sessionId: string): SessionState {
  const now = Date.now();
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastSeenAt = now;
    return existing;
  }
  const s: SessionState = {
    sessionId,
    createdAt: now,
    lastSeenAt: now,
  };
  sessions.set(sessionId, s);
  return s;
}

/* --------------------------- Utils --------------------------- */

function safeJsonParse(raw: unknown): unknown | null {
  try {
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
    if (typeof raw === "string") return JSON.parse(raw);
    return null;
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function send(ws: WebSocket, msg: ServerToClient) {
  ws.send(JSON.stringify({ ...msg, ts: Date.now() }));
}

function sendError(
  ws: WebSocket,
  sessionId: string,
  code: string,
  message: string
) {
  send(ws, { v: 1, type: "error", sessionId, code, message });
}

function validateClientMsg(payload: unknown): ClientToServer | null {
  if (!isObject(payload)) return null;

  const { v, type, sessionId } = payload;
  if (v !== 1 || typeof type !== "string" || typeof sessionId !== "string")
    return null;

  if (type === "ping") return { v: 1, type: "ping", sessionId };

  if (type === "session.start") {
    const { lang, vino_id, context } = payload;
    if (typeof lang !== "string" || typeof vino_id !== "string") return null;
    return {
  v: 1,
  type: "session.start",
  sessionId,
  lang,
  vino_id,
  context: context as Record<string, unknown> | undefined,
};

  }

  if (type === "user.message") {
    const { text } = payload;
    if (typeof text !== "string") return null;
    return { v: 1, type: "user.message", sessionId, text };
  }

  return null;
}

/* --------------------------- Stub --------------------------- */

async function generateSommelierReply(input: {
  lang: Lang;
  vino_id: string;
  userText: string;
}): Promise<string> {
  return input.lang.startsWith("es")
    ? `Para ${input.vino_id}: marida muy bien con carnes blancas, quesos curados y platos mediterráneos.`
    : `For ${input.vino_id}: pairs well with white meats, aged cheeses, and Mediterranean dishes.`;
}

/* --------------------------- HTTP + WS --------------------------- */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200);
  res.end("SommelierLab conv-runtime running");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    const payload = safeJsonParse(raw);
    const msg = validateClientMsg(payload);

    const fallbackSessionId =
      isObject(payload) && typeof payload.sessionId === "string"
        ? payload.sessionId
        : "unknown";

    if (!msg) {
      sendError(ws, fallbackSessionId, "INVALID_MESSAGE", "Mensaje inválido");
      return;
    }

    const session = upsertSession(msg.sessionId);

    try {
      if (msg.type === "ping") {
        send(ws, { v: 1, type: "pong", sessionId: msg.sessionId });
        return;
      }

      if (msg.type === "session.start") {
        session.lang = msg.lang;
        session.vino_id = msg.vino_id;
        send(ws, {
          v: 1,
          type: "session.ready",
          sessionId: msg.sessionId,
          capabilities: { text: true, audio: false, streaming: true },
        });
        return;
      }

      if (msg.type === "user.message") {
        if (!session.lang || !session.vino_id) {
          sendError(ws, msg.sessionId, "SESSION_NOT_READY", "session.start requerido");
          return;
        }

        send(ws, { v: 1, type: "assistant.thinking", sessionId: msg.sessionId });

        send(ws, {
          v: 1,
          type: "assistant.chunk",
          sessionId: msg.sessionId,
          delta: "Analizando… ",
        });

        const text = await generateSommelierReply({
          lang: session.lang,
          vino_id: session.vino_id,
          userText: msg.text,
        });

        send(ws, {
          v: 1,
          type: "assistant.message",
          sessionId: msg.sessionId,
          text,
        });
      }
    } catch (e) {
      sendError(ws, fallbackSessionId, "INTERNAL_ERROR", "Error interno");
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 conv-runtime listening on ${PORT}`);
});
