import express from "express";

const router = express.Router();

type ChatResponse = {
  ok?: boolean;
  text?: string;
};

router.post("/message", async (req, res) => {
  try {
    const { session_id, message } = req.body;

    if (!session_id || !message) {
      return res.status(400).json({
        ok: false,
        error: "session_id and message are required",
      });
    }

    const n8nResponse = await fetch(process.env.N8N_CHAT_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id,
        message,
      }),
    });

    const data = (await n8nResponse.json().catch(() => ({}))) as ChatResponse;

    const text = typeof data.text === "string" ? data.text : "";

    return res.json({
      ok: true,
      text,
    });

  } catch (error: any) {
    console.error("SESSION MESSAGE ERROR", error);

    return res.status(500).json({
      ok: false,
      error: "chat failed",
    });
  }
});

export default router;