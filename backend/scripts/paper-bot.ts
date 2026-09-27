import { runPaperOrchestrator } from "../src/orchestrator/run.js";

await runPaperOrchestrator({ replay: process.env.BOT_MODE === "REPLAY" });
