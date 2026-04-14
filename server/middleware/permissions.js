const checkPermission = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.Role) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const userRole = req.user.Role.role_name;

    if (userRole === 'Admin') {
      return next();
    }

    if (allowedRoles.includes(userRole)) {
      return next();
    }

    return res.status(403).json({ error: 'Insufficient permissions' });
  };
};

const checkSpecificPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user || !req.user.Role) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (req.user.Role.role_name === 'Admin') {
      return next();
    }

    if (req.user.Role[permission]) {
      return next();
    }

    return res.status(403).json({ error: 'Insufficient permissions' });
  };
};

module.exports = { checkPermission, checkSpecificPermission };
