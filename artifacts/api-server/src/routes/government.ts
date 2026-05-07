import { Router, type IRouter } from "express";
import { simulationEngine } from "../lib/simulation-engine";
import { GetGovernmentResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/government", (_req, res): void => {
  const gov = simulationEngine.getGovernment();
  res.json(GetGovernmentResponse.parse(gov));
});

export default router;
