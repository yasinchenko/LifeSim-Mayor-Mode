import { defineConfig } from "drizzle-kit";
import path from "path";

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.LIFESIM_DB_PATH ?? path.join(__dirname, ".data", "life-sim.sqlite"),
  },
});
