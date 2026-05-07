import { Router, type IRouter } from "express";
import { simulationEngine } from "../lib/simulation-engine";
import {
  GetConfigResponse,
  UpdateConfigBody,
  UpdateConfigResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middleware/admin";

const router: IRouter = Router();

router.get("/config", (_req, res): void => {
  const config = simulationEngine.getConfig();
  res.json(GetConfigResponse.parse(config));
});

router.put("/config", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const rangeErrors: string[] = [];

  if (data.taxRate !== undefined && (data.taxRate < 0 || data.taxRate > 1)) {
    rangeErrors.push("taxRate must be between 0 and 1");
  }
  if (data.tickIntervalMs !== undefined && data.tickIntervalMs < 1000) {
    rangeErrors.push("tickIntervalMs must be at least 1000 ms");
  }
  if (data.needDecayRate !== undefined && (data.needDecayRate < 0 || data.needDecayRate > 20)) {
    rangeErrors.push("needDecayRate must be between 0 and 20");
  }
  if (data.subsidyAmount !== undefined && data.subsidyAmount < 0) {
    rangeErrors.push("subsidyAmount must be non-negative");
  }
  if (data.baseSalary !== undefined && data.baseSalary < 0) {
    rangeErrors.push("baseSalary must be non-negative");
  }
  if (data.socialInteractionStrength !== undefined && (data.socialInteractionStrength < 0 || data.socialInteractionStrength > 10)) {
    rangeErrors.push("socialInteractionStrength must be between 0 and 10");
  }
  if (data.priceMarkup !== undefined && (data.priceMarkup < 0 || data.priceMarkup > 1)) {
    rangeErrors.push("priceMarkup must be between 0 and 1");
  }
  if (data.pensionRate !== undefined && (data.pensionRate < 0 || data.pensionRate > 1)) {
    rangeErrors.push("pensionRate must be between 0 and 1");
  }
  if (data.baseFoodPrice !== undefined && data.baseFoodPrice <= 0) {
    rangeErrors.push("baseFoodPrice must be positive");
  }
  if (data.initialAgents !== undefined && data.initialAgents < 1000) {
    rangeErrors.push("initialAgents must be at least 1000");
  }
  if (data.initialBusinesses !== undefined && data.initialBusinesses < 1) {
    rangeErrors.push("initialBusinesses must be at least 1");
  }

  if (rangeErrors.length > 0) {
    res.status(400).json({ error: rangeErrors.join("; ") });
    return;
  }
  const updated = await simulationEngine.updateConfig(data);
  res.json(UpdateConfigResponse.parse(updated));
});

export default router;
