import { Router, type IRouter } from "express";
import { simulationEngine } from "../lib/simulation-engine";
import {
  GetDailyDecisionsResponse,
  GetResidentRequestsResponse,
  IssueDailyDecisionBody,
  IssueDailyDecisionResponse,
  ProcessResidentRequestBody,
  ProcessResidentRequestResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/decisions/day", (_req, res): void => {
  const state = simulationEngine.getDailyDecisionsState();
  res.json(GetDailyDecisionsResponse.parse(state));
});

router.post("/decisions/issue", async (req, res): Promise<void> => {
  const parsed = IssueDailyDecisionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid decision payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const state = await simulationEngine.issueDailyDecision(parsed.data.decisionId);
    res.json(IssueDailyDecisionResponse.parse(state));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Decision unavailable";
    res.status(message === "UNKNOWN_DECISION" ? 404 : 409).json({ error: message });
  }
});

router.get("/decisions/requests", (_req, res): void => {
  const state = simulationEngine.getResidentRequestsState();
  res.json(GetResidentRequestsResponse.parse(state));
});

router.post("/decisions/requests/process", async (req, res): Promise<void> => {
  const parsed = ProcessResidentRequestBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid resident request payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const state = await simulationEngine.processResidentRequest(parsed.data.requestId, parsed.data.action);
    res.json(ProcessResidentRequestResponse.parse(state));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resident request unavailable";
    res.status(message === "UNKNOWN_RESIDENT_REQUEST" ? 404 : 409).json({ error: message });
  }
});

export default router;
