import { WebSocketServer, WebSocket } from "ws";
import http from "http";

const PORT = Number(process.env.PORT) || 3000;

type IncomingMessage =
  | { type: "session.start"; sessionId: string; lang: string; vino_id: string }
  | { type: "user.message"; text: string };

type OutgoingMessage =
  | { type: "session.ready"; sessionId: string }
  | { type: "assistant.thinking" }
  | { type: "assistant.message"; text: string };

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket) => {
  console.log("🔌 WS connected");

  ws.on("message", (raw) => {
    try {
      const msg: IncomingMessage = JSON.parse(raw.toString());

      if (msg.type === "session.start") {
        ws.send(
          JSON.stringify({
            type: "session.ready",
            sessionId: msg.sessionId,
          } satisfies OutgoingMessage)
        );
      }

      if (msg.type === "user.message") {
        ws.send(JSON.stringify({ type: "assistant.thinking" }));
        ws.send(
          JSON.stringify({
            type: "assistant.message",
            text: "Respuesta simulada del sommelier (aún sin n8n)",
          })
        );
      }
    } catch (e) {
      console.error("❌ Invalid WS message", e);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WS disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`🚀 conv-runtime WS listening on port ${PORT}`);
});
