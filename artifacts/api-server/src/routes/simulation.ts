import { Router, type IRouter } from "express";
import { simulationEngine } from "../lib/simulation-engine";
import {
  StartSimulationResponse,
  StopSimulationResponse,
  ResetSimulationResponse,
  GetSimulationStateResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middleware/admin";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/simulation/start", requireAdmin, async (req, res): Promise<void> => {
  await simulationEngine.start();
  const state = simulationEngine.getSimulationState();
  res.json(StartSimulationResponse.parse(state));
});

router.post("/simulation/stop", requireAdmin, async (req, res): Promise<void> => {
  await simulationEngine.stop();
  const state = simulationEngine.getSimulationState();
  res.json(StopSimulationResponse.parse(state));
});

router.post("/simulation/reset", requireAdmin, async (req, res): Promise<void> => {
  // Run reset in background so the HTTP request returns immediately.
  // The client polls /api/simulation/state to see when reset finishes.
  simulationEngine.reset().catch((err) => {
    logger.error({ err }, "Simulation reset failed");
  });
  // Return the current (pre-reset) state right away
  const state = simulationEngine.getSimulationState();
  res.json(ResetSimulationResponse.parse(state));
});

router.get("/simulation/state", (_req, res): void => {
  const state = simulationEngine.getSimulationState();
  res.json(GetSimulationStateResponse.parse(state));
});

export default router;
