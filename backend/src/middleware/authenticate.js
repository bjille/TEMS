const { verifyAccessToken } = require('../utils/tokens');
const { ApiError } = require('./errorHandler');
const User = require('../models/User');

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new ApiError(401, 'Missing or invalid Authorization header');
    }

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);
    if (!user || !user.active) {
      throw new ApiError(401, 'User not found or inactive');
    }

    req.user = user;
    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    next(new ApiError(401, 'Invalid or expired token'));
  }
}

function requireSuperadmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return next(new ApiError(403, 'Superadmin access required'));
  }
  next();
}

module.exports = { authenticate, requireSuperadmin };
