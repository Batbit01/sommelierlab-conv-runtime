import http from "http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 3000;

// HTTP server (Railway lo necesita)
const server = http.createServer();

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 WS connected");

  ws.on("message", (raw) => {
    const message =
      typeof raw === "string" ? raw : raw.toString("utf-8");

    console.log("📥 received:", message);

    // Respuesta mínima válida
    ws.send(
      JSON.stringify({
        type: "session.ready",
        ts: Date.now(),
      })
    );
  });

  ws.on("close", () => {
    console.log("🔌 WS disconnected");
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 conv-runtime WS listening on port ${PORT}`);
});
