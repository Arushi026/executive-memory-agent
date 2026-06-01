import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import connectDB from "./db/mongo.js";
import agentRoutes from "./routes/agentRoutes.js";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

connectDB();

app.use("/api/agent", agentRoutes);

app.get("/", (req, res) => {
  res.json({ status: "🧠 Executive Memory Agent is running" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});