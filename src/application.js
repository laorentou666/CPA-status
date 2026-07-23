import { Store } from './db.js';
import { CPAClient } from './cpa-client.js';
import { ProviderRegistry } from './providers.js';
import { NotificationService } from './notifiers.js';
import { AlertEngine } from './alerts.js';
import { SSEHub } from './sse.js';
import { MonitorScheduler } from './scheduler.js';
import { createHTTPServer } from './server.js';
import { AccountDeletionService } from './account-deletion.js';
import { CredentialImportService } from './credential-import.js';

export function createApplication(config, options = {}) {
  const logger = options.logger || console;
  const configManager = options.configManager || null;
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
  const credentialImport = options.credentialImport || new CredentialImportService({
    config,
    cpaClient,
    scheduler,
    logger,
  });
  const http = createHTTPServer({
    config,
    store,
    scheduler,
    notifications,
    providers,
    hub,
    accountDeletion,
    credentialImport,
    logger,
  });
  const server = http.server;

  const onConfigChange = ({ changedKeys, restartRequired }) => {
    if (restartRequired.length) {
      logger.warn?.(`[config] restart required for: ${restartRequired.join(', ')}`);
    }
    if (changedKeys.some((key) => [
      'cpaManagementURL', 'cpaManagementKey', 'requestTimeoutMs',
    ].includes(key))) {
      cpaClient.configure({
        managementURL: config.cpaManagementURL,
        managementKey: config.cpaManagementKey,
        timeoutMs: config.requestTimeoutMs,
      });
    }
    if (changedKeys.some((key) => [
      'notifyChannels', 'notifyMinSeverity', 'telegram', 'pushplus', 'serverchan',
    ].includes(key))) {
      notifications.configure(config);
    }
    if (changedKeys.some((key) => [
      'accountSyncIntervalMs', 'quotaSyncIntervalMs',
    ].includes(key))) {
      scheduler.reschedule();
    }
    http.reconfigure(config, changedKeys);
    hub.broadcast('config:update', {
      at: new Date().toISOString(),
    });
    hub.broadcast('dashboard:update', { source: 'config', at: new Date().toISOString() });

    if (changedKeys.some((key) => ['cpaManagementURL', 'cpaManagementKey'].includes(key))) {
      scheduler.trigger(true).catch((error) => logger.error('[config] CPA resync failed:', error.message));
    }
  };
  configManager?.on('change', onConfigChange);

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
    credentialImport,
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
      configManager?.startWatching();
      return server.address();
    },
    async stop() {
      configManager?.stopWatching();
      configManager?.off('change', onConfigChange);
      scheduler.stop();
      credentialImport.stop?.();
      hub.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}
