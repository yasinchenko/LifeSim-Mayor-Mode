import { pgTable, serial, text, integer, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const simStateTable = pgTable("sim_state", {
  id: serial("id").primaryKey(),
  tick: integer("tick").notNull().default(0),
  running: boolean("running").notNull().default(false),
  gameHour: integer("game_hour").notNull().default(0),
  gameDay: integer("game_day").notNull().default(1),
  governmentBudget: real("government_budget").notNull().default(10000),
  totalTaxCollected: real("total_tax_collected").notNull().default(0),
  totalSubsidiesPaid: real("total_subsidies_paid").notNull().default(0),
  totalPensionPaid: real("total_pension_paid").notNull().default(0),
  totalPublicServicesPaid: real("total_public_services_paid").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const simConfigTable = pgTable("sim_config", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

export const statsHistoryTable = pgTable("stats_history", {
  id: serial("id").primaryKey(),
  tick: integer("tick").notNull(),
  gameHour: integer("game_hour").notNull(),
  gameDay: integer("game_day").notNull(),
  avgMood: real("avg_mood").notNull(),
  gdp: real("gdp").notNull(),
  population: integer("population").notNull(),
  avgWealth: real("avg_wealth").notNull(),
  unemploymentRate: real("unemployment_rate").notNull(),
  governmentBudget: real("government_budget").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentStatHistoryTable = pgTable("agent_stat_history", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull(),
  tick: integer("tick").notNull(),
  money: real("money").notNull(),
  mood: real("mood").notNull(),
  age: integer("age").notNull(),
  socialization: real("socialization").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SimState = typeof simStateTable.$inferSelect;
export type SimConfig = typeof simConfigTable.$inferSelect;
export type StatsHistory = typeof statsHistoryTable.$inferSelect;
export type AgentStatHistory = typeof agentStatHistoryTable.$inferSelect;

export const insertSimConfigSchema = createInsertSchema(simConfigTable).omit({ id: true });
export type InsertSimConfig = z.infer<typeof insertSimConfigSchema>;

export const insertStatsHistorySchema = createInsertSchema(statsHistoryTable).omit({ id: true, recordedAt: true });
export type InsertStatsHistory = z.infer<typeof insertStatsHistorySchema>;

export const insertAgentStatHistorySchema = createInsertSchema(agentStatHistoryTable).omit({ id: true, recordedAt: true });
export type InsertAgentStatHistory = z.infer<typeof insertAgentStatHistorySchema>;
