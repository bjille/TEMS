const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const woningenRoutes = require('./routes/woningen');
const parametersRoutes = require('./routes/parameters');
const readingsRoutes = require('./routes/readings');
const controlRoutes = require('./routes/control');
const automationsRoutes = require('./routes/automations');
const globalAutomationsRoutes = require('./routes/globalAutomations');
const adminUsersRoutes = require('./routes/adminUsers');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json());
  if (env.nodeEnv !== 'test') {
    app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
  }

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/woningen', woningenRoutes);
  app.use('/api/woningen/:woningId/parameters', parametersRoutes);
  app.use('/api/woningen/:woningId/readings', readingsRoutes);
  app.use('/api/woningen/:woningId/control', controlRoutes);
  app.use('/api/woningen/:woningId/automations', automationsRoutes);
  app.use('/api/admin/global-automations', globalAutomationsRoutes);
  app.use('/api/admin/users', adminUsersRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
