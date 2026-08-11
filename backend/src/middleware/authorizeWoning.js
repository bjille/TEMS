const WoningUser = require('../models/WoningUser');
const { ApiError } = require('./errorHandler');

/**
 * Requires `authenticate` to have run first. Grants access if the user is a
 * superadmin, or has a WoningUser link to req.params.woningId. If `roles` is
 * given, membership role must be one of them (superadmin always passes).
 */
function authorizeWoning(roles) {
  return async function (req, res, next) {
    try {
      const { woningId } = req.params;
      if (req.user.role === 'superadmin') {
        return next();
      }

      const link = await WoningUser.findOne({ user: req.user._id, woning: woningId });
      if (!link) {
        throw new ApiError(403, 'No access to this woning');
      }
      if (roles && !roles.includes(link.role)) {
        throw new ApiError(403, `Requires role: ${roles.join(', ')}`);
      }

      req.woningRole = link.role;
      next();
    } catch (err) {
      if (err instanceof ApiError) return next(err);
      next(err);
    }
  };
}

module.exports = { authorizeWoning };
