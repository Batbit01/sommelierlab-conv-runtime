import { WebSocketServer, WebSocket } from "ws";
import http from "http";

const PORT: number = Number(process.env.PORT) || 3000;

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  console.log("🔌 WS connected");

  ws.on("message", (raw: Buffer) => {
    ws.send(
      JSON.stringify({
        type: "session.ready",
        ts: Date.now()
      })
    );
  });
});

server.listen(PORT, () => {
  console.log(`🚀 conv-runtime WS listening on port ${PORT}`);
});
