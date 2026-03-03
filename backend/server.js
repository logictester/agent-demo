import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import authRoutes from "./routes/auth.js";
import agentRoutes from "./routes/agent.js";
import delegationRoutes from "./routes/delegation.js";
import automationRoutes from "./routes/automation.js";
import { startAutomationScheduler } from "./services/automation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

const app = express();
const port = Number(process.env.PORT) || 4000;
const frontendDist = path.resolve(__dirname, "../frontend/dist");
const frontendDistReady = fs.existsSync(path.join(frontendDist, "index.html"));

app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/agent", agentRoutes);
app.use("/delegation", delegationRoutes);
app.use("/automation", automationRoutes);

if (frontendDistReady) {
  // Serve Vite production build (run `npm run build` first)
  app.use(express.static(frontendDist));
  app.get("*", (req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    return res.status(200).json({
      status: "ok",
      message:
        "Backend is running. Frontend build not found at frontend/dist. Use Vite dev server or run frontend build."
    });
  });
}

app.listen(port, () => console.log(`Server running on port ${port}`));
startAutomationScheduler();
