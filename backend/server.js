import express from "express";
import dotenv from "dotenv";
import cors from "cors";
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
const frontendDir = path.resolve(__dirname, "../frontend");

app.use(cors());
app.use(express.json());
app.use(express.static(frontendDir));

app.use("/auth", authRoutes);
app.use("/agent", agentRoutes);
app.use("/delegation", delegationRoutes);
app.use("/automation", automationRoutes);

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

app.listen(port, () => console.log(`Server running on port ${port}`));
startAutomationScheduler();
