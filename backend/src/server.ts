import cors from "cors";
import express from "express";
import { PAPER_TRADING } from "../config.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";

app.use(cors({ origin: frontendUrl }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", paperTrading: PAPER_TRADING });
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
