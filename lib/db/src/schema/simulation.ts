import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const simStateTable = sqliteTable("sim_state", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull().default(0),
  running: integer("running", { mode: "boolean" }).notNull().default(false),
  gameHour: integer("game_hour").notNull().default(0),
  gameDay: integer("game_day").notNull().default(1),
  scenarioType: text("scenario_type").notNull().default("balanced"),
  goalType: text("goal_type").notNull().default("balanced"),
  dayLimit: integer("day_limit").notNull().default(32),
  gameStatus: text("game_status").notNull().default("active"),
  gameOutcomeReason: text("game_outcome_reason"),
  actionPointsRemaining: integer("action_points_remaining").notNull().default(3),
  actionPointsMax: integer("action_points_max").notNull().default(3),
  governmentBudget: real("government_budget").notNull().default(10000),
  totalTaxCollected: real("total_tax_collected").notNull().default(0),
  totalSubsidiesPaid: real("total_subsidies_paid").notNull().default(0),
  totalPensionPaid: real("total_pension_paid").notNull().default(0),
  totalPublicServicesPaid: real("total_public_services_paid").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const simConfigTable = sqliteTable("sim_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
}, (table) => ({
  keyIdx: uniqueIndex("sim_config_key_idx").on(table.key),
}));

export const dailyDecreesTable = sqliteTable("daily_decrees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  decisionId: text("decision_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("pending"),
  issuedDay: integer("issued_day").notNull(),
  startDay: integer("start_day").notNull(),
  endDay: integer("end_day").notNull(),
  actionPointCost: integer("action_point_cost").notNull(),
  budgetCost: real("budget_cost").notNull().default(0),
  cooldownDays: integer("cooldown_days").notNull().default(0),
  effectsJson: text("effects_json").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  decisionDayIdx: index("daily_decrees_decision_day_idx").on(table.decisionId, table.issuedDay),
  statusDayIdx: index("daily_decrees_status_day_idx").on(table.status, table.endDay),
}));

export const statsHistoryTable = sqliteTable("stats_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull(),
  gameHour: integer("game_hour").notNull(),
  gameDay: integer("game_day").notNull(),
  avgMood: real("avg_mood").notNull(),
  gdp: real("gdp").notNull(),
  population: integer("population").notNull(),
  avgWealth: real("avg_wealth").notNull(),
  unemploymentRate: real("unemployment_rate").notNull(),
  governmentBudget: real("government_budget").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  tickIdx: index("stats_history_tick_idx").on(table.tick),
}));

export const agentStatHistoryTable = sqliteTable("agent_stat_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id").notNull(),
  tick: integer("tick").notNull(),
  money: real("money").notNull(),
  mood: real("mood").notNull(),
  age: integer("age").notNull(),
  socialization: real("socialization").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  agentTickIdx: index("agent_stat_history_agent_tick_idx").on(table.agentId, table.tick),
}));

export type SimState = typeof simStateTable.$inferSelect;
export type SimConfig = typeof simConfigTable.$inferSelect;
export type DailyDecree = typeof dailyDecreesTable.$inferSelect;
export type StatsHistory = typeof statsHistoryTable.$inferSelect;
export type AgentStatHistory = typeof agentStatHistoryTable.$inferSelect;

export const insertSimConfigSchema = createInsertSchema(simConfigTable).omit({ id: true });
export type InsertSimConfig = z.infer<typeof insertSimConfigSchema>;

export const insertStatsHistorySchema = createInsertSchema(statsHistoryTable).omit({ id: true, recordedAt: true });
export type InsertStatsHistory = z.infer<typeof insertStatsHistorySchema>;

export const insertAgentStatHistorySchema = createInsertSchema(agentStatHistoryTable).omit({ id: true, recordedAt: true });
export type InsertAgentStatHistory = z.infer<typeof insertAgentStatHistorySchema>;
