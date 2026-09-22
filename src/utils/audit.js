const db = require('../db/database');

function logAudit(req, action, description, userId = null) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, action, description, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId,
      action,
      description || '',
      req && req.ip ? req.ip : null,
      req && req.get ? (req.get('user-agent') || '') : ''
    );
  } catch (e) {
    // Audit log tidak boleh menggagalkan alur utama, tapi tetap catat ke console untuk investigasi.
    console.error('[AUDIT_LOG_FAILED]', action, e.message);
  }
}

module.exports = { logAudit };
