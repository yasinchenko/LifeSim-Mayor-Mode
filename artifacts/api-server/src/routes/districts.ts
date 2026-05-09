import { Router, type IRouter } from "express";
import {
  GetDistrictIncidentParams,
  GetDistrictIncidentResponse,
  GetDistrictResponse,
  HireDistrictStaffBody,
  HireDistrictStaffResponse,
  IgnoreDistrictIncidentParams,
  IgnoreDistrictIncidentResponse,
  InvestDistrictBody,
  InvestDistrictResponse,
  ListDistrictIncidentsQueryParams,
  ListDistrictIncidentsResponse,
  ListDistrictsResponse,
  RespondDistrictIncidentParams,
  RespondDistrictIncidentResponse,
} from "@workspace/api-zod";
import { simulationEngine } from "../lib/simulation-engine";

const router: IRouter = Router();

router.get("/districts", (_req, res): void => {
  res.json(ListDistrictsResponse.parse(simulationEngine.getDistricts()));
});

router.get("/district-incidents", (req, res): void => {
  const parsed = ListDistrictIncidentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid district incident query", details: parsed.error.flatten() });
    return;
  }

  res.json(ListDistrictIncidentsResponse.parse(simulationEngine.getDistrictIncidents(parsed.data.status)));
});

router.get("/district-incidents/:id", (req, res): void => {
  const params = GetDistrictIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid district incident id", details: params.error.flatten() });
    return;
  }

  const incident = simulationEngine.getDistrictIncident(params.data.id);
  if (!incident) {
    res.status(404).json({ error: "District incident not found" });
    return;
  }

  res.json(GetDistrictIncidentResponse.parse(incident));
});

router.post("/district-incidents/:id/respond", async (req, res): Promise<void> => {
  const params = RespondDistrictIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid district incident id", details: params.error.flatten() });
    return;
  }

  try {
    const result = await simulationEngine.respondDistrictIncident(params.data.id);
    res.json(RespondDistrictIncidentResponse.parse(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : "District incident response unavailable";
    res.status(message === "UNKNOWN_DISTRICT_INCIDENT" ? 404 : 409).json({ error: message });
  }
});

router.post("/district-incidents/:id/ignore", async (req, res): Promise<void> => {
  const params = IgnoreDistrictIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid district incident id", details: params.error.flatten() });
    return;
  }

  try {
    const result = await simulationEngine.ignoreDistrictIncident(params.data.id);
    res.json(IgnoreDistrictIncidentResponse.parse(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : "District incident ignore unavailable";
    res.status(message === "UNKNOWN_DISTRICT_INCIDENT" ? 404 : 409).json({ error: message });
  }
});

router.get("/districts/:id", (req, res): void => {
  const district = simulationEngine.getDistrict(req.params.id);
  if (!district) {
    res.status(404).json({ error: "District not found" });
    return;
  }

  res.json(GetDistrictResponse.parse(district));
});

router.post("/districts/:id/hire", async (req, res): Promise<void> => {
  const parsed = HireDistrictStaffBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid district hire payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const district = await simulationEngine.hireDistrictStaff(
      req.params.id,
      parsed.data.service,
      parsed.data.count ?? 1,
    );
    res.json(HireDistrictStaffResponse.parse(district));
  } catch (err) {
    const message = err instanceof Error ? err.message : "District hire unavailable";
    res.status(message === "UNKNOWN_DISTRICT" ? 404 : 409).json({ error: message });
  }
});

router.post("/districts/:id/invest", async (req, res): Promise<void> => {
  const parsed = InvestDistrictBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid district investment payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const district = await simulationEngine.investDistrict(req.params.id, parsed.data.type);
    res.json(InvestDistrictResponse.parse(district));
  } catch (err) {
    const message = err instanceof Error ? err.message : "District investment unavailable";
    res.status(message === "UNKNOWN_DISTRICT" ? 404 : 409).json({ error: message });
  }
});

export default router;
