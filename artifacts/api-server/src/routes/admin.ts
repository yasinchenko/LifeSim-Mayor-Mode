import { Router, type IRouter } from "express";
import { verifyPassword, createAdminToken } from "../lib/admin-auth";

const router: IRouter = Router();

router.post("/admin/login", (req, res): void => {
  const { password } = req.body as { password?: string };
  if (typeof password !== "string" || !verifyPassword(password)) {
    res.status(401).json({ error: "Неверный пароль" });
    return;
  }
  const token = createAdminToken();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  res.json({ token, expiresAt });
});

export default router;
