import { KeychainStore } from '../server/auth/KeychainStore.js';

const [key, value] = process.argv.slice(2);
if (!key || !value) {
  console.error('Usage: pnpm --filter @secretary/service set-secret <key> <value>');
  process.exit(1);
}
new KeychainStore().set(key, value);
console.log(`Stored secret under key "${key}".`);
