import { Router, type IRouter } from "express";
import healthRouter from "./health";
import simulationRouter from "./simulation";
import agentsRouter from "./agents";
import economyRouter from "./economy";
import governmentRouter from "./government";
import configRouter from "./config";
import statsRouter from "./stats";
import adminRouter from "./admin";
import debugRouter from "./debug";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use(simulationRouter);
router.use(agentsRouter);
router.use(economyRouter);
router.use(governmentRouter);
router.use(configRouter);
router.use(statsRouter);
router.use(debugRouter);

export default router;
