const { verifyAccessToken } = require('../utils/tokens');
const User = require('../models/User');
const WoningUser = require('../models/WoningUser');

function initSockets(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) throw new Error('Missing auth token');
      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub);
      if (!user || !user.active) throw new Error('User not found or inactive');
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('join-woning', async (woningId, ack) => {
      try {
        if (socket.user.role !== 'superadmin') {
          const link = await WoningUser.findOne({ user: socket.user._id, woning: woningId });
          if (!link) return ack?.({ ok: false, error: 'forbidden' });
        }
        socket.join(`woning:${woningId}`);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: 'internal_error' });
      }
    });

    socket.on('leave-woning', (woningId) => {
      socket.leave(`woning:${woningId}`);
    });
  });
}

module.exports = { initSockets };
