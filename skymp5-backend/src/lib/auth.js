'use strict';

const crypto = require('crypto');
const config = require('../config');

// Constant-time compare so a wrong key cannot be recovered by timing the
// response. Lengths are compared first because timingSafeEqual throws on a
// length mismatch, and length alone is not worth protecting.
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

// An unset key means the capability is disabled, not open. Defaulting to open
// would make a misconfigured deployment silently world-writable.
function requireKey(configuredKey, label) {
  return (req, res, next) => {
    if (!configuredKey) {
      return res.status(503).json({
        error: `${label} is not configured on this backend`,
      });
    }
    if (!secretsMatch(bearerToken(req), configuredKey)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

module.exports = {
  secretsMatch,
  requireRegistration: requireKey(config.registrationKey, 'REGISTRATION_KEY'),
  requireAdmin: requireKey(config.adminKey, 'ADMIN_KEY'),
};
