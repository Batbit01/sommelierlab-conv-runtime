import { WebSocketServer } from "ws";
import http from "http";

const PORT = Number(process.env.PORT) || 8080;

/**
 * HTTP SERVER (obligatorio para Railway)
 */
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(200);
  res.end("conv-runtime alive");
});

/**
 * WEBSOCKET SERVER
 */
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  console.log("🔌 WS connected from", req.socket.remoteAddress);

  ws.on("message", (raw) => {
    const text = raw.toString();
    console.log("⬅️ WS message:", text);

    // ping / pong básico
    if (text === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    try {
      const msg = JSON.parse(text);

      if (msg.type === "session.start") {
        ws.send(JSON.stringify({
          type: "session.ready",
          sessionId: msg.sessionId,
        }));
      }

      if (msg.type === "user.message") {
        ws.send(JSON.stringify({ type: "assistant.thinking" }));
        ws.send(JSON.stringify({
          type: "assistant.message",
          text: "Respuesta simulada del sommelier",
        }));
      }
    } catch (err) {
      console.error("❌ Invalid WS message", err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WS disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`🚀 conv-runtime listening on port ${PORT}`);
});
