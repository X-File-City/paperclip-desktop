import { autoUpdater } from "electron-updater";
import { app, dialog, BrowserWindow } from "electron";
import log from "electron-log";

const updaterLogger = {
  info: (...args: unknown[]) => log.info(...args),
  warn: (...args: unknown[]) => log.warn(...args),
  error: (...args: unknown[]) => {
    if (args.some((arg) => isMissingReleaseFeedError(arg))) {
      log.warn("[updater] No published release feed is available yet; skipping update check");
      return;
    }

    log.error(...args);
  },
};

// Route autoUpdater logs through electron-log, but downgrade the expected
// GitHub 404 feed miss until a release feed actually exists.
autoUpdater.logger = updaterLogger as typeof log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

/**
 * Call this once from the main process after the window is ready.
 *
 * Usage in main.ts:
 *   import { initAutoUpdater } from "./updater";
 *   mainWindow.once("ready-to-show", () => initAutoUpdater(mainWindow));
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  // Don't check for updates in dev
  if (!app.isPackaged) {
    log.info("[updater] Skipping update check in dev mode");
    return;
  }

  autoUpdater.on("checking-for-update", () => {
    log.info("[updater] Checking for updates...");
    sendStatus(mainWindow, "checking");
  });

  autoUpdater.on("update-available", (info) => {
    log.info(`[updater] Update available: v${info.version}`);
    sendStatus(mainWindow, "available", info.version);
  });

  autoUpdater.on("update-not-available", () => {
    log.info("[updater] App is up to date");
    sendStatus(mainWindow, "up-to-date");
  });

  autoUpdater.on("download-progress", (progress) => {
    sendStatus(mainWindow, "downloading", undefined, Math.round(progress.percent));
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info(`[updater] Update downloaded: v${info.version}`);
    sendStatus(mainWindow, "downloaded", info.version);

    // Prompt user to restart
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "Update Ready",
        message: `Paperclip v${info.version} has been downloaded.`,
        detail: "Restart now to apply the update?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    if (isMissingReleaseFeedError(err)) {
      sendStatus(mainWindow, "up-to-date");
      return;
    }

    log.error("[updater] Error:", err);
    sendStatus(mainWindow, "error");
  });

  // Initial check, then every 4 hours
  void checkForUpdatesSafely(mainWindow);
  setInterval(
    () => {
      void checkForUpdatesSafely(mainWindow);
    },
    4 * 60 * 60 * 1000,
  );
}

type UpdateStatus = "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";

function sendStatus(win: BrowserWindow, status: UpdateStatus, version?: string, percent?: number): void {
  win.webContents.send("update-status", { status, version, percent });
}

async function checkForUpdatesSafely(mainWindow: BrowserWindow): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (isMissingReleaseFeedError(err)) {
      sendStatus(mainWindow, "up-to-date");
      return;
    }

    log.error("[updater] Update check failed:", err);
    sendStatus(mainWindow, "error");
  }
}

function isMissingReleaseFeedError(err: unknown): boolean {
  if (typeof err === "string") {
    return err.includes("releases.atom") && err.includes("404");
  }

  if (!err || typeof err !== "object") {
    return false;
  }

  const maybeHttpError = err as { statusCode?: number; message?: string; stack?: string };
  return (
    maybeHttpError.statusCode === 404 &&
    (
      (typeof maybeHttpError.message === "string" && maybeHttpError.message.includes("releases.atom")) ||
      (typeof maybeHttpError.stack === "string" && maybeHttpError.stack.includes("releases.atom"))
    )
  );
}
