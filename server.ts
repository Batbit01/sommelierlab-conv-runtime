import { WebSocketServer } from "ws";
import http from "http";

const PORT = Number(process.env.PORT) || 3000;

// Railway necesita un HTTP server
const server = http.createServer();

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  console.log("🔌 WS connected from", req.socket.remoteAddress);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "session.init") {
        ws.send(
          JSON.stringify({
            type: "session.ready",
            ts: Date.now(),
            payload: {
              session_id: msg.payload?.session_id,
              kp_cached: false,
              lang_effective: msg.payload?.lang || "es",
              capabilities: {
                audio_out: false,
                text_out: true
              }
            }
          })
        );
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "session.error",
          ts: Date.now(),
          payload: {
            code: "INVALID_MESSAGE",
            message: "No se pudo parsear el mensaje"
          }
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("❌ WS disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`🚀 conv-runtime WS listening on port ${PORT}`);
});
