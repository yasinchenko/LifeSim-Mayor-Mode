import { Router, type IRouter, type Response } from "express";
import {
  GetMayorOfficeResponse,
  ProvideMayorOfficeServiceBody,
  ProvideMayorOfficeServiceResponse,
  PurchaseMayorOfficeBody,
  PurchaseMayorOfficeResponse,
  SkimMayorOfficeCityBudgetBody,
  SkimMayorOfficeCityBudgetResponse,
  SkimMayorOfficeServiceBudgetBody,
  SkimMayorOfficeServiceBudgetResponse,
} from "@workspace/api-zod";
import { simulationEngine } from "../lib/simulation-engine";

const router: IRouter = Router();

function handleMayorOfficeError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "Mayor office operation unavailable";
  const status = message === "MAYOR_OFFICE_OPERATION_NOT_IMPLEMENTED" ? 501 : 409;
  res.status(status).json({ error: message });
}

router.get("/mayor-office", (_req, res): void => {
  res.json(GetMayorOfficeResponse.parse(simulationEngine.getMayorOffice()));
});

router.post("/mayor-office/skim-city-budget", async (req, res): Promise<void> => {
  const parsed = SkimMayorOfficeCityBudgetBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid mayor office city budget payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await simulationEngine.skimCityBudgetToMayorOffice(parsed.data.level);
    res.json(SkimMayorOfficeCityBudgetResponse.parse(result));
  } catch (err) {
    handleMayorOfficeError(res, err);
  }
});

router.post("/mayor-office/skim-service-budget", async (req, res): Promise<void> => {
  const parsed = SkimMayorOfficeServiceBudgetBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid mayor office service budget payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await simulationEngine.skimServiceBudgetToMayorOffice(
      parsed.data.districtId,
      parsed.data.service,
      parsed.data.level,
    );
    res.json(SkimMayorOfficeServiceBudgetResponse.parse(result));
  } catch (err) {
    handleMayorOfficeError(res, err);
  }
});

router.post("/mayor-office/provide-service", async (req, res): Promise<void> => {
  const parsed = ProvideMayorOfficeServiceBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid mayor office service payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await simulationEngine.provideMayorOfficeService(
      parsed.data.districtId,
      parsed.data.dealId,
      parsed.data.level,
    );
    res.json(ProvideMayorOfficeServiceResponse.parse(result));
  } catch (err) {
    handleMayorOfficeError(res, err);
  }
});

router.post("/mayor-office/purchase", async (req, res): Promise<void> => {
  const parsed = PurchaseMayorOfficeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid mayor office purchase payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await simulationEngine.purchaseMayorOfficeItem(parsed.data.item);
    res.json(PurchaseMayorOfficeResponse.parse(result));
  } catch (err) {
    handleMayorOfficeError(res, err);
  }
});

export default router;
