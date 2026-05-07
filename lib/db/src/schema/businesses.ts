import { pgTable, serial, text, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const businessesTable = pgTable("businesses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  balance: real("balance").notNull().default(1000),
  productionRate: real("production_rate").notNull().default(10),
  ownerId: integer("owner_id"),
  productivityLevel: integer("productivity_level").notNull().default(0),
});

export const goodsTable = pgTable("goods", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  businessId: integer("business_id").references(() => businessesTable.id, { onDelete: "cascade" }),
  basePrice: real("base_price").notNull().default(10),
  currentPrice: real("current_price").notNull().default(10),
  quality: real("quality").notNull().default(50),
  demand: real("demand").notNull().default(50),
  supply: real("supply").notNull().default(50),
});

export const insertBusinessSchema = createInsertSchema(businessesTable).omit({ id: true });
export type InsertBusiness = z.infer<typeof insertBusinessSchema>;
export type Business = typeof businessesTable.$inferSelect;

export const insertGoodSchema = createInsertSchema(goodsTable).omit({ id: true });
export type InsertGood = z.infer<typeof insertGoodSchema>;
export type Good = typeof goodsTable.$inferSelect;
