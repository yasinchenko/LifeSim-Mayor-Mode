import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { statsHistoryTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { simulationEngine } from "../lib/simulation-engine";
import {
  GetStatsHistoryQueryParams,
  GetStatsHistoryResponse,
  GetStatsSummaryResponse,
  GetTopAgentsQueryParams,
  GetTopAgentsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/stats/history", async (req, res): Promise<void> => {
  const parsed = GetStatsHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const limit = parsed.data.limit ?? 50;
  const rows = await db
    .select()
    .from(statsHistoryTable)
    .orderBy(desc(statsHistoryTable.tick))
    .limit(limit);
  res.json(GetStatsHistoryResponse.parse(rows.reverse()));
});

router.get("/stats/summary", (_req, res): void => {
  const summary = simulationEngine.getStatsSummary();
  res.json(GetStatsSummaryResponse.parse(summary));
});

router.get("/stats/top-agents", (req, res): void => {
  const parsed = GetTopAgentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const limit = parsed.data.limit ?? 10;
  const top = simulationEngine.getTopAgents(limit);
  res.json(GetTopAgentsResponse.parse(top));
});

router.get("/stats/population-breakdown", (_req, res): void => {
  res.json(simulationEngine.getPopulationBreakdown());
});

router.get("/stats/population-groups", (req, res): void => {
  const groupBy = req.query.groupBy as string;
  if (!["personality", "employment", "ageGroup"].includes(groupBy)) {
    res.status(400).json({ error: "groupBy must be personality | employment | ageGroup" });
    return;
  }
  res.json(simulationEngine.getPopulationGroups(groupBy as "personality" | "employment" | "ageGroup"));
});

router.get("/stats/needs", (_req, res): void => {
  res.json(simulationEngine.getNeedsStats());
});

router.get("/events", (_req, res): void => {
  res.json(simulationEngine.getEvents());
});

export default router;
