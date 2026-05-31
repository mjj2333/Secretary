import { Menu, shell, type MenuItemConstructorOptions } from 'electron';

export interface TrayMenuActions {
  port: number;
  needsSetup: boolean;
  bootstrapToken: string;
  paused: boolean;
  onPauseResume: () => void;
  onQuit: () => void;
  logPath: string;
}

export function buildTrayMenu(a: TrayMenuActions): Menu {
  const openUrl = `https://localhost:${a.port}/#bootstrap=${a.bootstrapToken}`;
  const items: MenuItemConstructorOptions[] = [
    {
      label: a.needsSetup ? 'Setup required — Open Secretary' : 'Open Secretary',
      click: () => void shell.openExternal(openUrl),
    },
    { type: 'separator' },
    { label: a.paused ? 'Resume' : 'Pause', click: a.onPauseResume },
    { label: 'View Logs', click: () => void shell.openPath(a.logPath) },
    { type: 'separator' },
    { label: 'Quit', click: a.onQuit },
  ];
  return Menu.buildFromTemplate(items);
}
