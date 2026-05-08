import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import { app, BrowserWindow, shell, type BrowserWindow as BrowserWindowType } from "electron";

app.setName("LifeSim Mayor Mode");
app.setPath("userData", path.join(app.getPath("appData"), "LifeSim Mayor Mode"));

interface StartedApiServer {
  url: string;
  server: {
    close(callback?: (err?: Error) => void): void;
  };
}

type StartApiServer = (options: { port: number; host: string }) => Promise<StartedApiServer>;

let mainWindow: BrowserWindowType | null = null;
let apiServer: StartedApiServer | null = null;

function writeDesktopLog(message: string, error?: unknown): void {
  try {
    const logPath = path.join(app.getPath("userData"), "desktop.log");
    const detail = error instanceof Error
      ? `${error.stack ?? error.message}`
      : error === undefined
        ? ""
        : String(error);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}${detail ? `\n${detail}` : ""}\n`);
  } catch {
    // Nothing else to do before the app window exists.
  }
}

function getApiEntryPath(): string {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), "api-server", "dist", "index.mjs");
  }

  return path.resolve(app.getAppPath(), "..", "api-server", "dist", "index.mjs");
}

function getStaticDir(): string {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), "life-sim", "public");
  }

  return path.resolve(app.getAppPath(), "..", "life-sim", "dist", "public");
}

async function startLocalApi(): Promise<StartedApiServer> {
  process.env.LIFESIM_STATIC_DIR = getStaticDir();
  process.env.LIFESIM_DB_PATH = path.join(app.getPath("userData"), "life-sim.sqlite");
  process.env.NODE_ENV = app.isPackaged ? "production" : "development";

  const apiModule = await import(pathToFileURL(getApiEntryPath()).href) as {
    startApiServer: StartApiServer;
  };

  return apiModule.startApiServer({ port: 0, host: "127.0.0.1" });
}

async function createWindow(): Promise<void> {
  apiServer = await startLocalApi();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: "#0f1117",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(apiServer.url);
}

app.whenReady().then(() => {
  writeDesktopLog("App ready");
  void createWindow().catch((err) => {
    writeDesktopLog("Failed to create window", err);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((err) => {
        writeDesktopLog("Failed to recreate window", err);
        app.quit();
      });
    }
  });
});

process.on("uncaughtException", (err) => {
  writeDesktopLog("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  writeDesktopLog("Unhandled rejection", reason);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (!apiServer) return;

  event.preventDefault();
  const serverToClose = apiServer;
  apiServer = null;
  serverToClose.server.close(() => app.quit());
});
