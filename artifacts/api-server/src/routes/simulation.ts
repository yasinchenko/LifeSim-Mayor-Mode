import { Router, type IRouter } from "express";
import { simulationEngine } from "../lib/simulation-engine";
import {
  StartSimulationResponse,
  StopSimulationResponse,
  ResetSimulationResponse,
  GetSimulationStateResponse,
  NewGameBody,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/simulation/start", async (req, res): Promise<void> => {
  await simulationEngine.start();
  const state = simulationEngine.getSimulationState();
  res.json(StartSimulationResponse.parse(state));
});

router.post("/simulation/stop", async (req, res): Promise<void> => {
  await simulationEngine.stop();
  const state = simulationEngine.getSimulationState();
  res.json(StopSimulationResponse.parse(state));
});

router.post("/simulation/reset", async (req, res): Promise<void> => {
  // Run reset in background so the HTTP request returns immediately.
  // The client polls /api/simulation/state to see when reset finishes.
  simulationEngine.reset().catch((err) => {
    logger.error({ err }, "Simulation reset failed");
  });
  // Return the current (pre-reset) state right away
  const state = simulationEngine.getSimulationState();
  res.json(ResetSimulationResponse.parse(state));
});

router.post("/simulation/new-game", async (req, res): Promise<void> => {
  const parsed = NewGameBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid new game options", details: parsed.error.flatten() });
    return;
  }

  simulationEngine.newGame(parsed.data).catch((err) => {
    logger.error({ err }, "New game reset failed");
  });

  const state = simulationEngine.getSimulationState();
  res.json(GetSimulationStateResponse.parse(state));
});

router.get("/simulation/state", (_req, res): void => {
  const state = simulationEngine.getSimulationState();
  res.json(GetSimulationStateResponse.parse(state));
});

export default router;
