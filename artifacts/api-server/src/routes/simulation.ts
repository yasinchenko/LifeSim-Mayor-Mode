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

  try {
    await simulationEngine.newGame(parsed.data);
    const state = simulationEngine.getSimulationState();
    res.json(GetSimulationStateResponse.parse(state));
  } catch (err) {
    logger.error({ err }, "New game reset failed");
    const message = err instanceof Error ? err.message : "NEW_GAME_FAILED";
    res.status(500).json({ error: message });
  }
});

router.get("/simulation/saves", (_req, res): void => {
  res.json(simulationEngine.listGameSaves());
});

router.post("/simulation/saves", async (req, res): Promise<void> => {
  try {
    const saved = await simulationEngine.saveGame(req.body?.slotId, req.body?.name);
    res.json(saved);
  } catch (err) {
    const message = err instanceof Error ? err.message : "SAVE_FAILED";
    res.status(message === "INVALID_SAVE_SLOT" ? 400 : 500).json({ error: message });
  }
});

router.post("/simulation/saves/:slotId/load", async (req, res): Promise<void> => {
  try {
    const state = await simulationEngine.loadGameSave(req.params.slotId);
    res.json(GetSimulationStateResponse.parse(state));
  } catch (err) {
    const message = err instanceof Error ? err.message : "LOAD_FAILED";
    res.status(message === "SAVE_SLOT_NOT_FOUND" ? 404 : message === "INVALID_SAVE_SLOT" ? 400 : 500).json({ error: message });
  }
});

router.delete("/simulation/saves/:slotId", (req, res): void => {
  try {
    res.json(simulationEngine.deleteGameSave(req.params.slotId));
  } catch (err) {
    const message = err instanceof Error ? err.message : "DELETE_FAILED";
    res.status(message === "INVALID_SAVE_SLOT" ? 400 : 500).json({ error: message });
  }
});

router.get("/simulation/state", (_req, res): void => {
  const state = simulationEngine.getSimulationState();
  res.json(GetSimulationStateResponse.parse(state));
});

export default router;
