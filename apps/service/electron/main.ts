import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { app, Tray, nativeImage } from 'electron';
import { startServer, type ServerHandle } from './server-process.js';
import { buildTrayMenu } from './tray-menu.js';

const here = dirname(fileURLToPath(import.meta.url));
let tray: Tray | undefined;
let server: ServerHandle | undefined;
let paused = false;

function refresh(): void {
  if (!tray) return;
  tray.setContextMenu(
    buildTrayMenu({
      port: server?.port ?? 47824,
      // The live needs-setup status + one-time bootstrap token will be wired over IPC
      // when the setup wizard lands (Phase 2.5). For now the tray opens the served origin.
      needsSetup: false,
      bootstrapToken: '',
      paused,
      onPauseResume: () => {
        paused = !paused;
        refresh();
      },
      onQuit: () => app.quit(),
      logPath: join(homedir(), '.secretary', 'logs', 'service.log'),
    }),
  );
}

async function bootstrap(): Promise<void> {
  server = await startServer();
  const icon = nativeImage.createFromPath(join(here, 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Secretary');
  refresh();
}

app
  .whenReady()
  .then(bootstrap)
  .catch((err: unknown) => {
    console.error(err);
    app.quit();
  });

app.on('window-all-closed', () => {
  // Tray-only app: do not quit when there are no windows.
});

app.on('before-quit', () => {
  // SIGTERM triggers the server's graceful shutdown (close server + checkpoint WAL).
  server?.child.kill();
});
