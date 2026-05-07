import { pgTable, serial, text, integer, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const agentsTable = pgTable("agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  gender: text("gender").notNull(),
  age: integer("age").notNull(),
  mood: real("mood").notNull().default(50),
  money: real("money").notNull().default(100),
  personality: text("personality").notNull().default("balanced"),
  socialization: real("socialization").notNull().default(50),
  currentAction: text("current_action").notNull().default("idle"),
  employerId: integer("employer_id"),
  isRetired: boolean("is_retired").notNull().default(false),
  jobHistory: text("job_history").notNull().default("[]"),
  locationX: real("location_x").notNull().default(0),
  locationY: real("location_y").notNull().default(0),
  careerLevel: integer("career_level").notNull().default(1),
  ambition: real("ambition").notNull().default(50),
  strength: real("strength").notNull().default(50),
  intelligence: real("intelligence").notNull().default(50),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const needsTable = pgTable("needs", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull().references(() => agentsTable.id, { onDelete: "cascade" }),
  hunger: real("hunger").notNull().default(80),
  comfort: real("comfort").notNull().default(80),
  social: real("social").notNull().default(80),
  health: real("health").notNull().default(80),
  sleep: real("sleep").notNull().default(80),
  education: real("education").notNull().default(70),
  entertainment: real("entertainment").notNull().default(70),
  faith: real("faith").notNull().default(60),
  housingSafety: real("housing_safety").notNull().default(80),
  financialSafety: real("financial_safety").notNull().default(80),
  physicalSafety: real("physical_safety").notNull().default(80),
  socialRating: real("social_rating").notNull().default(50),
  wellbeing: real("wellbeing").notNull().default(70),
});

export const relationsTable = pgTable("relations", {
  id: serial("id").primaryKey(),
  agentIdA: integer("agent_id_a").notNull().references(() => agentsTable.id, { onDelete: "cascade" }),
  agentIdB: integer("agent_id_b").notNull().references(() => agentsTable.id, { onDelete: "cascade" }),
  friendshipLevel: real("friendship_level").notNull().default(50),
});

export const insertAgentSchema = createInsertSchema(agentsTable).omit({ id: true, createdAt: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agentsTable.$inferSelect;

export const insertNeedsSchema = createInsertSchema(needsTable).omit({ id: true });
export type InsertNeeds = z.infer<typeof insertNeedsSchema>;
export type Needs = typeof needsTable.$inferSelect;

export const insertRelationsSchema = createInsertSchema(relationsTable).omit({ id: true });
export type InsertRelations = z.infer<typeof insertRelationsSchema>;
export type Relation = typeof relationsTable.$inferSelect;
