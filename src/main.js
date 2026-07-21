import { ConfigManager } from './config.js';
import { createApplication } from './application.js';

const configManager = new ConfigManager();
const config = configManager.current();
const app = createApplication(config, { configManager });

try {
  const address = await app.start();
  const host = typeof address === 'object' ? address.address : config.host;
  const port = typeof address === 'object' ? address.port : config.port;
  console.log(`[cpa-status] listening on http://${host}:${port}`);
  console.log(`[cpa-status] CPA management endpoint: ${config.cpaManagementURL}`);
} catch (error) {
  console.error('[cpa-status] failed to start:', error);
  process.exit(1);
}

async function shutdown(signal) {
  console.log(`[cpa-status] received ${signal}, shutting down`);
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
