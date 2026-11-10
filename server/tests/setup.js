const pool = require('../src/config/db');

const dbUrl = process.env.DATABASE_URL || '';

try {
  const parsed = new URL(dbUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (dbName !== 'syncpad_test') {
    throw new Error(`expected "syncpad_test", got "${dbName}"`);
  }
} catch (err) {
  console.error(
    `SAFETY: DATABASE_URL must point to exactly "syncpad_test". ${err.message}\n` +
    `Current DATABASE_URL: ${dbUrl}`
  );
  process.exit(1);
}

async function resetDatabase() {
  await pool.query('DELETE FROM document_collaborators');
  await pool.query('DELETE FROM documents');
  await pool.query('DELETE FROM users');
}

module.exports = { resetDatabase };
