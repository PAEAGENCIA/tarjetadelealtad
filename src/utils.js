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
    products: parseList(b.products),
    createdAt: b.created_at
  };
}

function parseList(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch (e) {
    return [];
  }
}

// Limpia una lista de textos: sin vacíos, sin repetidos, con límite de cantidad y largo.
function cleanList(input, maxItems, maxLen) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    const t = String(item || '').trim().slice(0, maxLen);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function isEmail(raw) {
  const e = String(raw || '').trim();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

function customerToJSON(c) {
  return {
    phone: c.phone,
    name: c.name,
    progress: c.progress,
    redemptions: c.redemptions,
    status: c.status || 'active',
    given: c.given != null ? c.given : undefined,
    createdAt: c.created_at
  };
}

// Versión completa para el panel del negocio (con PIN). Nunca se usa en la vista pública.
function customerPrivateJSON(c) {
  return {
    ...customerToJSON(c),
    email: c.email || '',
    favorites: parseList(c.favorites),
    marketingOptIn: Boolean(c.marketing_opt_in),
    privacyAcceptedAt: c.privacy_accepted_at || null
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

// Límite simple de peticiones por conexión (evita que alguien llene un negocio de solicitudes falsas).
const hits = new Map();
function overLimit(req, bucket, max, windowMs) {
  const key = `${bucket}|${req.ip}`;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.first > windowMs) {
    hits.set(key, { count: 1, first: now });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

module.exports = {
  overLimit,
  slugify, normalizePhone, goalFor, businessToJSON, customerToJSON, customerPrivateJSON,
  parseList, cleanList, isEmail,
  isBlocked, recordFailure, clearFailures
};
