function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'negocio';
}

// Deja solo dígitos para que "222 123 4567", "(222) 123-4567" y "+52 222 123 4567" sean el mismo cliente.
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('52')) digits = digits.slice(2);
  if (digits.length === 13 && digits.startsWith('521')) digits = digits.slice(3);
  return digits;
}

function goalFor(business) {
  return business.mechanic === 'sellos' ? business.stamps_goal : business.points_goal;
}

// Formatea una fila de "business" de snake_case (SQLite) a camelCase (API). Nunca incluye el PIN.
function businessToJSON(b) {
  return {
    slug: b.slug,
    name: b.name,
    mechanic: b.mechanic,
    stampsGoal: b.stamps_goal,
    pointsGoal: b.points_goal,
    pointsPerVisit: b.points_per_visit,
    rewardDesc: b.reward_desc,
    color: b.color,
    createdAt: b.created_at
  };
}

function customerToJSON(c) {
  return {
    phone: c.phone,
    name: c.name,
    progress: c.progress,
    redemptions: c.redemptions,
    given: c.given != null ? c.given : undefined,
    createdAt: c.created_at
  };
}

// Freno contra adivinar el PIN: después de 10 intentos fallidos en 15 minutos,
// ese negocio queda bloqueado desde esa conexión hasta que pase el tiempo.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

function attemptKey(req, slug) {
  return `${slug}|${req.ip}`;
}

function isBlocked(req, slug) {
  const entry = failures.get(attemptKey(req, slug));
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(attemptKey(req, slug));
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(req, slug) {
  const key = attemptKey(req, slug);
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    failures.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearFailures(req, slug) {
  failures.delete(attemptKey(req, slug));
}

module.exports = {
  slugify, normalizePhone, goalFor, businessToJSON, customerToJSON,
  isBlocked, recordFailure, clearFailures
};
