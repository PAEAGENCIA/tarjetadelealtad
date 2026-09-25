const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const {
  slugify, businessToJSON, isBlocked, recordFailure, clearFailures, cleanList
} = require('../utils');

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

// Revisa el PIN del negocio. Responde el error y devuelve false si no es válido.
function requirePin(req, res, business) {
  if (isBlocked(req, business.slug)) {
    res.status(429).json({ error: 'Demasiados intentos con PIN incorrecto. Espera 15 minutos.' });
    return false;
  }
  const pin = req.header('x-business-pin') || req.body?.pin;
  if (!safeEqual(pin, business.pin)) {
    recordFailure(req, business.slug);
    res.status(401).json({ error: 'PIN incorrecto.' });
    return false;
  }
  clearFailures(req, business.slug);
  return true;
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

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Escribe el nombre de tu negocio.' });
  if (!['sellos', 'puntos'].includes(mechanic)) return res.status(400).json({ error: 'Elige sellos o puntos.' });
  if (!rewardDesc || !String(rewardDesc).trim()) return res.status(400).json({ error: 'Describe el premio que da tu tarjeta.' });
  if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos.' });
  if (mechanic === 'sellos' && !(Number(stampsGoal) >= 2 && Number(stampsGoal) <= 30)) {
    return res.status(400).json({ error: 'Los sellos para el premio deben ser entre 2 y 30.' });
  }
  if (mechanic === 'puntos' && !(Number(pointsGoal) >= 1 && Number(pointsPerVisit) >= 1)) {
    return res.status(400).json({ error: 'Completa los puntos del premio y los puntos por visita.' });
  }
  if (color && !HEX_COLOR.test(color)) return res.status(400).json({ error: 'Color inválido.' });

  const slug = generateUniqueSlug(name);
  db.prepare(`
    INSERT INTO businesses (slug, name, pin, mechanic, stamps_goal, points_goal, points_per_visit, reward_desc, color, created_at)
    VALUES (@slug, @name, @pin, @mechanic, @stampsGoal, @pointsGoal, @pointsPerVisit, @rewardDesc, @color, @createdAt)
  `).run({
    slug,
    name: String(name).trim().slice(0, 60),
    pin: String(pin),
    mechanic,
    stampsGoal: mechanic === 'sellos' ? Math.round(Number(stampsGoal)) : null,
    pointsGoal: mechanic === 'puntos' ? Math.round(Number(pointsGoal)) : null,
    pointsPerVisit: mechanic === 'puntos' ? Math.round(Number(pointsPerVisit)) : null,
    rewardDesc: String(rewardDesc).trim().slice(0, 60),
    color: color || '#E62E6B',
    createdAt: new Date().toISOString()
  });

  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug);
  res.status(201).json(businessToJSON(business));
});

// Entrar al panel (valida PIN)
router.post('/:slug/login', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos un negocio con ese código.' });
  if (!requirePin(req, res, business)) return;
  res.json(businessToJSON(business));
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
  if (!requirePin(req, res, business)) return;

  const { rewardDesc, stampsGoal, pointsGoal, pointsPerVisit, color, products } = req.body || {};
  if (products != null && !Array.isArray(products)) return res.status(400).json({ error: 'Lista de productos inválida.' });
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
      products = COALESCE(@products, products)
    WHERE id = @id
  `).run({
    id: business.id,
    rewardDesc: rewardDesc != null ? String(rewardDesc).trim().slice(0, 60) : null,
    stampsGoal: isSellos && stampsGoal != null ? Math.round(Number(stampsGoal)) : null,
    pointsGoal: !isSellos && pointsGoal != null ? Math.round(Number(pointsGoal)) : null,
    pointsPerVisit: !isSellos && pointsPerVisit != null ? Math.round(Number(pointsPerVisit)) : null,
    color: color ?? null,
    products: products != null ? JSON.stringify(cleanList(products, 12, 30)) : null
  });

  const updated = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);
  res.json(businessToJSON(updated));
});

module.exports = { router, requirePin, adminRequired };
