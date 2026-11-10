const crypto = require('crypto');

const tickets = new Map();
const TICKET_TTL_MS = 30000;

function createTicket(user, docId, role) {
  const id = crypto.randomBytes(32).toString('hex');
  tickets.set(id, { user, docId, role, expiresAt: Date.now() + TICKET_TTL_MS });
  return id;
}

function consumeTicket(id) {
  const entry = tickets.get(id);
  if (!entry) return null;
  tickets.delete(id);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tickets) {
    if (now > entry.expiresAt) tickets.delete(key);
  }
}, 60000);
_cleanupInterval.unref();

function invalidateTicketsForUser(docId, userId) {
  for (const [key, entry] of tickets) {
    if (entry.docId === docId && entry.user.id === userId) {
      tickets.delete(key);
    }
  }
}

module.exports = { createTicket, consumeTicket, invalidateTicketsForUser, tickets };
