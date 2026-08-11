const http = require('http');
const { Server } = require('socket.io');
const env = require('./config/env');
const { connectDb } = require('./config/db');
const { createApp } = require('./app');
const { initSockets } = require('./sockets');
const { haConnectionManager } = require('./services/haConnectionManager');
const { automationEngine } = require('./services/automationEngine');
const { globalAutomationEngine } = require('./services/globalAutomationEngine');

async function main() {
  await connectDb();
  console.log('Connected to MongoDB');

  const app = createApp();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: { origin: env.corsOrigin, credentials: true },
  });
  initSockets(io);
  app.set('io', io);

  await haConnectionManager.startAll(io);
  await automationEngine.loadAll();
  await globalAutomationEngine.loadAll();

  server.listen(env.port, () => {
    console.log(`TEMS backend listening on port ${env.port}`);
  });

  process.on('SIGTERM', () => shutdown(server));
  process.on('SIGINT', () => shutdown(server));
}

function shutdown(server) {
  console.log('Shutting down...');
  haConnectionManager.stopAll();
  server.close(() => process.exit(0));
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
