import { Router, type IRouter } from "express";
import { simulationEngine } from "../lib/simulation-engine";
import {
  ListBusinessesResponse,
  ListGoodsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/businesses", (_req, res): void => {
  const businesses = simulationEngine.getBusinesses();
  res.json(ListBusinessesResponse.parse(businesses));
});

router.get("/goods", (_req, res): void => {
  const goods = simulationEngine.getGoods();
  res.json(ListGoodsResponse.parse(goods));
});

export default router;
