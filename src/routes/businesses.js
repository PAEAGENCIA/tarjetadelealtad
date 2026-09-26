const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const {
  slugify, businessToJSON, isBlocked, recordFailure, clearFailures, cleanList, isValidPin, accessInfo, todayMx, addDays,
  BASE_COLORS, STAMP_ICON_IDS, CARD_STYLES, PLANS, isPremium
} = require('../utils');

const PREMIUM_ONLY = 'Esta función es del plan Premium.';

const router = express.Router();

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function generateUniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  let i = 1;
  const exists = db.prepare('SELECT 1 FROM businesses WHERE slug = ?');
  while (exists.get(slug)) {
    i += 1;
    slug = `${base}-${i}`;
  }
  return slug;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Revisa el PIN del negocio. Devuelve 'owner' (PIN del dueño) o 'staff' (PIN del personal).
// Si no es válido, responde el error y devuelve false.
// Si la prueba o el servicio ya venció, el panel queda en pausa (nada se borra): responde 402.
function requirePin(req, res, business, opts = {}) {
  if (isBlocked(req, business.slug)) {
    res.status(429).json({ error: 'Demasiados intentos con PIN incorrecto. Espera 15 minutos.' });
    return false;
  }
  const pin = req.header('x-business-pin') || req.body?.pin;
  let role = false;
  if (safeEqual(pin, business.pin)) role = 'owner';
  else if (business.staff_pin && safeEqual(pin, business.staff_pin)) role = 'staff';
  if (!role) {
    recordFailure(req, business.slug);
    res.status(401).json({ error: 'PIN incorrecto.' });
    return false;
  }
  clearFailures(req, business.slug);
  if (!opts.allowExpired && accessInfo(business).expired) {
    res.status(402).json({ code: 'expired', error: 'El periodo de este negocio terminó. Contacta a P.A.E. para continuar.' });
    return false;
  }
  return role;
}

// Solo el PIN del dueño: ajustes, diseño, PINs y descargar la base de clientes.
function requireOwner(req, res, business, opts = {}) {
  const role = requirePin(req, res, business, opts);
  if (!role) return false;
  if (role !== 'owner') {
    res.status(403).json({ error: 'Esto solo lo puede hacer el dueño del negocio.' });
    return false;
  }
  return role;
}

function adminRequired() {
  return Boolean(process.env.ADMIN_KEY);
}

// Crear negocio. Si ADMIN_KEY está configurada, solo quien la conoce puede crear negocios.
router.post('/', (req, res) => {
  if (adminRequired()) {
    if (isBlocked(req, '__admin__')) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    }
    if (!safeEqual(req.header('x-admin-key'), process.env.ADMIN_KEY)) {
      recordFailure(req, '__admin__');
      return res.status(401).json({ error: 'La clave de administrador no es correcta.' });
    }
    clearFailures(req, '__admin__');
  }

  const { name, mechanic, stampsGoal, pointsGoal, pointsPerVisit, rewardDesc, color, pin } = req.body || {};
  const plan = PLANS.includes(req.body?.plan) ? req.body.plan : 'esencial';

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Escribe el nombre de tu negocio.' });
  if (!['sellos', 'puntos'].includes(mechanic)) return res.status(400).json({ error: 'Elige sellos o puntos.' });
  if (!rewardDesc || !String(rewardDesc).trim()) return res.status(400).json({ error: 'Describe el premio que da tu tarjeta.' });
  if (!isValidPin(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 a 8 dígitos.' });
  if (mechanic === 'sellos' && !(Number(stampsGoal) >= 2 && Number(stampsGoal) <= 30)) {
    return res.status(400).json({ error: 'Los sellos para el premio deben ser entre 2 y 30.' });
  }
  if (mechanic === 'puntos' && !(Number(pointsGoal) >= 1 && Number(pointsPerVisit) >= 1)) {
    return res.status(400).json({ error: 'Completa los puntos del premio y los puntos por visita.' });
  }
  if (color && !HEX_COLOR.test(color)) return res.status(400).json({ error: 'Color inválido.' });
  if (color && plan !== 'premium' && !BASE_COLORS.includes(color.toUpperCase())) {
    return res.status(403).json({ error: 'Los colores personalizados son del plan Premium.' });
  }

  // Prueba gratis: por defecto 30 días. trialDays = 0 crea el negocio sin fecha límite.
  const trialDays = req.body?.trialDays === undefined ? 30 : Math.max(0, Math.min(365, Math.round(Number(req.body.trialDays) || 0)));
  const slug = generateUniqueSlug(name);
  db.prepare(`
    INSERT INTO businesses (slug, name, pin, mechanic, stamps_goal, points_goal, points_per_visit, reward_desc, color, created_at, plan,
      access_type, access_until)
    VALUES (@slug, @name, @pin, @mechanic, @stampsGoal, @pointsGoal, @pointsPerVisit, @rewardDesc, @color, @createdAt, @plan,
      @accessType, @accessUntil)
  `).run({
    accessType: trialDays ? 'trial' : null,
    accessUntil: trialDays ? addDays(todayMx(), trialDays - 1) : null,
    slug,
    name: String(name).trim().slice(0, 60),
    pin: String(pin),
    mechanic,
    stampsGoal: mechanic === 'sellos' ? Math.round(Number(stampsGoal)) : null,
    pointsGoal: mechanic === 'puntos' ? Math.round(Number(pointsGoal)) : null,
    pointsPerVisit: mechanic === 'puntos' ? Math.round(Number(pointsPerVisit)) : null,
    rewardDesc: String(rewardDesc).trim().slice(0, 60),
    color: (color || '#E62E6B').toUpperCase(),
    createdAt: new Date().toISOString(),
    plan
  });

  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug);
  res.status(201).json({ ...businessToJSON(business), role: 'owner', hasStaffPin: false, access: accessInfo(business) });
});

// Entrar al panel (valida PIN)
router.post('/:slug/login', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos un negocio con ese código.' });
  const role = requirePin(req, res, business, { allowExpired: true });
  if (!role) return;
  const access = accessInfo(business);
  const out = { ...businessToJSON(business), role, hasStaffPin: role === 'owner' ? Boolean(business.staff_pin) : undefined, access };
  if (access.expired) {
    // Panel en pausa: solo se muestra cuántos clientes y solicitudes lo esperan.
    out.waiting = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END), 0) AS customers,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
      FROM customers WHERE business_id = ?`).get(business.id);
  }
  res.json(out);
});

// Cambiar el PIN del dueño. Todos los celulares que tenían sesión con el PIN anterior se salen solos.
router.put('/:slug/pin', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requireOwner(req, res, business)) return;
  const newPin = String(req.body?.newPin || '');
  if (!isValidPin(newPin)) return res.status(400).json({ error: 'El PIN nuevo debe ser de 4 a 8 dígitos.' });
  if (business.staff_pin && newPin === business.staff_pin) {
    return res.status(400).json({ error: 'El PIN del dueño debe ser distinto al del personal.' });
  }
  db.prepare('UPDATE businesses SET pin = ? WHERE id = ?').run(newPin, business.id);
  res.json({ ok: true });
});

// Crear, cambiar o quitar el PIN del personal (solo el dueño).
router.put('/:slug/staff-pin', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requireOwner(req, res, business)) return;
  const staffPin = req.body?.staffPin;
  if (staffPin === null || staffPin === '') {
    db.prepare('UPDATE businesses SET staff_pin = NULL WHERE id = ?').run(business.id);
    return res.json({ ok: true, hasStaffPin: false });
  }
  if (!isValidPin(staffPin)) return res.status(400).json({ error: 'El PIN del personal debe ser de 4 a 8 dígitos.' });
  if (String(staffPin) === business.pin) {
    return res.status(400).json({ error: 'El PIN del personal debe ser distinto al tuyo.' });
  }
  db.prepare('UPDATE businesses SET staff_pin = ? WHERE id = ?').run(String(staffPin), business.id);
  res.json({ ok: true, hasStaffPin: true });
});

// Info pública del negocio (la usa la vista del cliente, sin PIN)
router.get('/:slug', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  res.json(businessToJSON(business));
});

// Actualizar configuración (requiere PIN)
router.put('/:slug', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requireOwner(req, res, business)) return;

  const { rewardDesc, stampsGoal, pointsGoal, pointsPerVisit, color, products, stampIcon, cardTitle, cardStyle } = req.body || {};
  const premium = isPremium(business);
  if (!premium && (products != null || stampIcon != null || cardTitle != null || cardStyle != null)) {
    return res.status(403).json({ error: PREMIUM_ONLY });
  }
  // En Esencial solo se eligen colores de la paleta. Si el negocio bajó de Premium,
  // puede conservar el color que ya tenía (y seguir guardando su premio y meta).
  const sameColor = String(color || '').toUpperCase() === String(business.color || '').toUpperCase();
  if (color != null && !premium && !sameColor && !BASE_COLORS.includes(String(color).toUpperCase())) {
    return res.status(403).json({ error: 'Los colores personalizados son del plan Premium.' });
  }
  if (products != null && !Array.isArray(products)) return res.status(400).json({ error: 'Lista de productos inválida.' });
  if (stampIcon != null && !STAMP_ICON_IDS.includes(stampIcon)) return res.status(400).json({ error: 'Ícono inválido.' });
  if (cardStyle != null && !CARD_STYLES.includes(cardStyle)) return res.status(400).json({ error: 'Estilo inválido.' });
  if (rewardDesc != null && !String(rewardDesc).trim()) return res.status(400).json({ error: 'El premio no puede quedar vacío.' });
  if (color != null && !HEX_COLOR.test(color)) return res.status(400).json({ error: 'Color inválido.' });
  if (business.mechanic === 'sellos' && stampsGoal != null && !(Number(stampsGoal) >= 2 && Number(stampsGoal) <= 30)) {
    return res.status(400).json({ error: 'Los sellos para el premio deben ser entre 2 y 30.' });
  }
  if (business.mechanic === 'puntos' && ((pointsGoal != null && !(Number(pointsGoal) >= 1)) || (pointsPerVisit != null && !(Number(pointsPerVisit) >= 1)))) {
    return res.status(400).json({ error: 'Los puntos deben ser 1 o más.' });
  }

  const isSellos = business.mechanic === 'sellos';
  db.prepare(`
    UPDATE businesses SET
      reward_desc = COALESCE(@rewardDesc, reward_desc),
      stamps_goal = COALESCE(@stampsGoal, stamps_goal),
      points_goal = COALESCE(@pointsGoal, points_goal),
      points_per_visit = COALESCE(@pointsPerVisit, points_per_visit),
      color = COALESCE(@color, color),
      products = COALESCE(@products, products),
      stamp_icon = COALESCE(@stampIcon, stamp_icon),
      card_title = CASE WHEN @cardTitle IS NULL THEN card_title ELSE NULLIF(@cardTitle, '') END,
      card_style = COALESCE(@cardStyle, card_style)
    WHERE id = @id
  `).run({
    id: business.id,
    rewardDesc: rewardDesc != null ? String(rewardDesc).trim().slice(0, 60) : null,
    stampsGoal: isSellos && stampsGoal != null ? Math.round(Number(stampsGoal)) : null,
    pointsGoal: !isSellos && pointsGoal != null ? Math.round(Number(pointsGoal)) : null,
    pointsPerVisit: !isSellos && pointsPerVisit != null ? Math.round(Number(pointsPerVisit)) : null,
    color: color != null ? String(color).toUpperCase() : null,
    products: products != null ? JSON.stringify(cleanList(products, 12, 30)) : null,
    stampIcon: stampIcon ?? null,
    cardTitle: cardTitle != null ? String(cardTitle).trim().slice(0, 24) : null,
    cardStyle: cardStyle ?? null
  });

  const updated = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);
  res.json(businessToJSON(updated));
});

// ---------- Logo del negocio (plan Premium) ----------
const LOGO_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

router.put('/:slug/logo', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requireOwner(req, res, business)) return;
  if (!isPremium(business)) return res.status(403).json({ error: 'El logo propio es del plan Premium.' });

  const m = String(req.body?.image || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Sube una imagen PNG, JPG o WEBP.' });
  const bytes = Buffer.from(m[2], 'base64');
  const magic = LOGO_TYPES[m[1]];
  if (!magic.every((b, i) => bytes[i] === b)) return res.status(400).json({ error: 'El archivo no es una imagen válida.' });
  if (bytes.length > 200 * 1024) return res.status(400).json({ error: 'La imagen es muy pesada (máximo 200 KB).' });

  db.prepare('UPDATE businesses SET logo = ?, logo_version = logo_version + 1 WHERE id = ?')
    .run(`${m[1]};${m[2]}`, business.id);
  res.json(businessToJSON(db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id)));
});

router.delete('/:slug/logo', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requireOwner(req, res, business)) return;
  db.prepare('UPDATE businesses SET logo = NULL, logo_version = logo_version + 1 WHERE id = ?').run(business.id);
  res.json(businessToJSON(db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id)));
});

router.get('/:slug/logo', (req, res) => {
  const business = db.prepare('SELECT logo, plan FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business || !business.logo || !isPremium(business)) return res.status(404).end();
  const [type, data] = business.logo.split(';');
  res.set('Content-Type', type);
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // la liga cambia (?v=) cada vez que se sube otro logo
  res.send(Buffer.from(data, 'base64'));
});

module.exports = { router, requirePin, requireOwner, adminRequired, safeEqual };
