import type { Request, Response, NextFunction } from "express";
import { verifyAdminToken } from "../lib/admin-auth";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Требуется авторизация администратора" });
    return;
  }
  const token = auth.slice(7);
  if (!verifyAdminToken(token)) {
    res.status(401).json({ error: "Токен недействителен или истёк" });
    return;
  }
  next();
}
