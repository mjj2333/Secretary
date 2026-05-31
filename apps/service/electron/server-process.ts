import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  child: ChildProcess;
  port: number;
}

/** Forks the headless server (built JS) as a plain Node process, resolving once it signals readiness. */
export function startServer(): Promise<ServerHandle> {
  const entry = join(here, '..', 'server', 'index.js');
  const child = fork(entry, [], {
    // Run the forked Electron binary as plain Node so it executes the server script.
    // (Native modules then load under Electron's ABI — see `pnpm rebuild:electron`.)
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    const onMessage = (msg: unknown): void => {
      if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'ready') {
        child.off('message', onMessage);
        resolve({ child, port: (msg as { port: number }).port });
      }
    };
    child.on('message', onMessage);
    child.on('exit', (code) => reject(new Error(`Server exited early (code ${code ?? 'null'})`)));
  });
}
