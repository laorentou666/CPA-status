import { Store } from './db.js';
import { CPAClient } from './cpa-client.js';
import { ProviderRegistry } from './providers.js';
import { NotificationService } from './notifiers.js';
import { AlertEngine } from './alerts.js';
import { SSEHub } from './sse.js';
import { MonitorScheduler } from './scheduler.js';
import { createHTTPServer } from './server.js';
import { AccountDeletionService } from './account-deletion.js';

export function createApplication(config, options = {}) {
  const logger = options.logger || console;
  const store = options.store || new Store(config.databasePath);
  const providers = options.providers || new ProviderRegistry();
  const cpaClient = options.cpaClient || new CPAClient({
    managementURL: config.cpaManagementURL,
    managementKey: config.cpaManagementKey,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl: options.fetchImpl || fetch,
  });
  const notifications = options.notifications || new NotificationService(
    config,
    store,
    options.fetchImpl || fetch
  );
  const hub = options.hub || new SSEHub();
  const alerts = options.alerts || new AlertEngine(store, notifications);
  const scheduler = options.scheduler || new MonitorScheduler({
    config,
    store,
    cpaClient,
    providers,
    alerts,
    hub,
    logger,
  });
  const accountDeletion = options.accountDeletion || new AccountDeletionService({
    store,
    cpaClient,
    scheduler,
    alerts,
  });
  const server = createHTTPServer({
    config,
    store,
    scheduler,
    notifications,
    providers,
    hub,
    accountDeletion,
    logger,
  });

  return {
    config,
    store,
    providers,
    cpaClient,
    notifications,
    alerts,
    hub,
    scheduler,
    accountDeletion,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      scheduler.start();
      return server.address();
    },
    async stop() {
      scheduler.stop();
      hub.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}
