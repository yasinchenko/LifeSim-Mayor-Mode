import { Router, type IRouter } from "express";
import { simulationEngine } from "../lib/simulation-engine";
import {
  ListAgentsQueryParams,
  ListAgentsResponse,
  GetAgentParams,
  GetAgentResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/agents", async (req, res): Promise<void> => {
  const parsed = ListAgentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { page = 1, limit = 50, sortBy, sortDir, filterAction } = parsed.data;
  const result = simulationEngine.getAgents(
    page,
    limit,
    sortBy as string | undefined,
    sortDir as string | undefined,
    filterAction as string | undefined
  );
  res.json(ListAgentsResponse.parse(result));
});

router.get("/agents/:id/stat-history", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid agent id" });
    return;
  }
  const history = simulationEngine.getAgentStatHistory(id);
  res.json(history);
});

router.get("/agents/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid agent id" });
    return;
  }

  const agent = simulationEngine.getAgent(id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const relations = simulationEngine.getAgentRelations(id);
  res.json(GetAgentResponse.parse({ ...agent, relations }));
});

export default router;
