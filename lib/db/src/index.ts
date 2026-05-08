import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

interface LocalSqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface LocalSqliteDatabase {
  prepare(source: string): LocalSqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): (...args: Parameters<T>) => ReturnType<T>;
  pragma(source: string): unknown;
  exec(source: string): unknown;
}

function getDefaultDbPath(): string {
  const appName = "LifeSim Mayor Mode";

  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, appName, "life-sim.sqlite");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName, "life-sim.sqlite");
  }

  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, appName, "life-sim.sqlite");
}

export const dbPath = process.env.LIFESIM_DB_PATH ?? getDefaultDbPath();

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const sqliteInstance = new Database(dbPath);
export const sqlite = sqliteInstance as unknown as LocalSqliteDatabase;
sqliteInstance.pragma("journal_mode = WAL");
sqliteInstance.pragma("foreign_keys = ON");
sqliteInstance.pragma("busy_timeout = 5000");

function bootstrapSchema(): void {
  sqliteInstance.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      gender TEXT NOT NULL,
      age INTEGER NOT NULL,
      mood REAL NOT NULL DEFAULT 50,
      money REAL NOT NULL DEFAULT 100,
      personality TEXT NOT NULL DEFAULT 'balanced',
      socialization REAL NOT NULL DEFAULT 50,
      current_action TEXT NOT NULL DEFAULT 'idle',
      employer_id INTEGER,
      is_retired INTEGER NOT NULL DEFAULT 0,
      job_history TEXT NOT NULL DEFAULT '[]',
      location_x REAL NOT NULL DEFAULT 0,
      location_y REAL NOT NULL DEFAULT 0,
      career_level INTEGER NOT NULL DEFAULT 1,
      ambition REAL NOT NULL DEFAULT 50,
      strength REAL NOT NULL DEFAULT 50,
      intelligence REAL NOT NULL DEFAULT 50,
      created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 1000,
      production_rate REAL NOT NULL DEFAULT 10,
      owner_id INTEGER,
      productivity_level INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS goods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
      base_price REAL NOT NULL DEFAULT 10,
      current_price REAL NOT NULL DEFAULT 10,
      quality REAL NOT NULL DEFAULT 50,
      demand REAL NOT NULL DEFAULT 50,
      supply REAL NOT NULL DEFAULT 50
    );

    CREATE TABLE IF NOT EXISTS needs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      hunger REAL NOT NULL DEFAULT 80,
      comfort REAL NOT NULL DEFAULT 80,
      social REAL NOT NULL DEFAULT 80,
      health REAL NOT NULL DEFAULT 80,
      sleep REAL NOT NULL DEFAULT 80,
      education REAL NOT NULL DEFAULT 70,
      entertainment REAL NOT NULL DEFAULT 70,
      faith REAL NOT NULL DEFAULT 60,
      housing_safety REAL NOT NULL DEFAULT 80,
      financial_safety REAL NOT NULL DEFAULT 80,
      physical_safety REAL NOT NULL DEFAULT 80,
      social_rating REAL NOT NULL DEFAULT 50,
      wellbeing REAL NOT NULL DEFAULT 70
    );

    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id_a INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      agent_id_b INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      friendship_level REAL NOT NULL DEFAULT 50
    );

    DROP INDEX IF EXISTS relations_agent_pair_idx;

    CREATE TABLE IF NOT EXISTS sim_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0,
      game_hour INTEGER NOT NULL DEFAULT 0,
      game_day INTEGER NOT NULL DEFAULT 1,
      scenario_type TEXT NOT NULL DEFAULT 'balanced',
      goal_type TEXT NOT NULL DEFAULT 'balanced',
      day_limit INTEGER NOT NULL DEFAULT 32,
      game_status TEXT NOT NULL DEFAULT 'active',
      game_outcome_reason TEXT,
      postgame_mode INTEGER NOT NULL DEFAULT 0,
      action_points_remaining INTEGER NOT NULL DEFAULT 3,
      action_points_max INTEGER NOT NULL DEFAULT 3,
      government_budget REAL NOT NULL DEFAULT 10000,
      total_tax_collected REAL NOT NULL DEFAULT 0,
      total_subsidies_paid REAL NOT NULL DEFAULT 0,
      total_pension_paid REAL NOT NULL DEFAULT 0,
      total_public_services_paid REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );

    CREATE TABLE IF NOT EXISTS sim_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_decrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      issued_day INTEGER NOT NULL,
      start_day INTEGER NOT NULL,
      end_day INTEGER NOT NULL,
      action_point_cost INTEGER NOT NULL,
      budget_cost REAL NOT NULL DEFAULT 0,
      cooldown_days INTEGER NOT NULL DEFAULT 0,
      effects_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );

    CREATE INDEX IF NOT EXISTS daily_decrees_decision_day_idx
      ON daily_decrees(decision_id, issued_day);

    CREATE INDEX IF NOT EXISTS daily_decrees_status_day_idx
      ON daily_decrees(status, end_day);

    CREATE TABLE IF NOT EXISTS stats_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      game_hour INTEGER NOT NULL,
      game_day INTEGER NOT NULL,
      avg_mood REAL NOT NULL,
      gdp REAL NOT NULL,
      population INTEGER NOT NULL,
      avg_wealth REAL NOT NULL,
      unemployment_rate REAL NOT NULL,
      government_budget REAL NOT NULL,
      recorded_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );

    CREATE INDEX IF NOT EXISTS stats_history_tick_idx
      ON stats_history(tick);

    CREATE TABLE IF NOT EXISTS agent_stat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      money REAL NOT NULL,
      mood REAL NOT NULL,
      age INTEGER NOT NULL,
      socialization REAL NOT NULL,
      recorded_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );

    CREATE INDEX IF NOT EXISTS agent_stat_history_agent_tick_idx
      ON agent_stat_history(agent_id, tick);

    CREATE TABLE IF NOT EXISTS save_slots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const simStateColumns = new Set(
    sqliteInstance.prepare("PRAGMA table_info(sim_state)").all().map((row) => String((row as { name: string }).name)),
  );
  const addSimStateColumn = (name: string, ddl: string) => {
    if (!simStateColumns.has(name)) {
      sqliteInstance.exec(`ALTER TABLE sim_state ADD COLUMN ${ddl}`);
    }
  };

  addSimStateColumn("scenario_type", "scenario_type TEXT NOT NULL DEFAULT 'balanced'");
  addSimStateColumn("goal_type", "goal_type TEXT NOT NULL DEFAULT 'balanced'");
  addSimStateColumn("day_limit", "day_limit INTEGER NOT NULL DEFAULT 32");
  addSimStateColumn("game_status", "game_status TEXT NOT NULL DEFAULT 'active'");
  addSimStateColumn("game_outcome_reason", "game_outcome_reason TEXT");
  addSimStateColumn("postgame_mode", "postgame_mode INTEGER NOT NULL DEFAULT 0");
  addSimStateColumn("action_points_remaining", "action_points_remaining INTEGER NOT NULL DEFAULT 3");
  addSimStateColumn("action_points_max", "action_points_max INTEGER NOT NULL DEFAULT 3");
}

bootstrapSchema();

export const db = drizzle(sqliteInstance, { schema });

export * from "./schema";
