import { existsSync, readFileSync } from 'node:fs';

export interface HttpsOptions {
  cert: Buffer;
  key: Buffer;
}

/** Loads the mkcert-generated cert/key, with a clear remediation message if absent. */
export function loadHttpsOptions(certPath: string, keyPath: string): HttpsOptions {
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(
      `HTTPS cert not found at ${certPath} / ${keyPath}. ` +
        `Run infra/mkcert/setup-certs.ps1 to generate local certificates (requires mkcert).`,
    );
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}
