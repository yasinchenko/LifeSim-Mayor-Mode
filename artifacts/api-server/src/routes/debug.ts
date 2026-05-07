import { Router, type IRouter } from "express";
import { simulationEngine } from "../lib/simulation-engine";

const router: IRouter = Router();

router.get("/debug/tick", (_req, res): void => {
  const report = simulationEngine.getLastTickReport();
  if (!report) {
    res.status(204).end();
    return;
  }
  res.json(report);
});

export default router;
