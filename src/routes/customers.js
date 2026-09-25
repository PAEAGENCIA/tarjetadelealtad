const express = require('express');
const db = require('../db');
const { slugify, normalizePhone, goalFor, customerToJSON } = require('../utils');
const { requirePin } = require('./businesses');

const router = express.Router({ mergeParams: true });

const WITH_GIVEN = `
  SELECT c.*, (
    SELECT COALESCE(SUM(h.amount), 0) FROM history h
    WHERE h.customer_id = c.id AND h.type = 'add'
  ) AS given
  FROM customers c
`;

function getBusiness(slug) {
  return db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(slug));
}

function getCustomer(businessId, phone) {
  return db.prepare(`${WITH_GIVEN} WHERE c.business_id = ? AND c.phone = ?`).get(businessId, phone);
}

// Listar todos los clientes del negocio (requiere PIN)
router.get('/', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;

  const rows = db.prepare(`${WITH_GIVEN} WHERE c.business_id = ? ORDER BY c.created_at DESC`).all(business.id);
  res.json(rows.map(customerToJSON));
});

// Ver la tarjeta de un cliente (pública: la usa la vista "Ver mi tarjeta")
router.get('/:phone', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'no_card' });
  const { given, ...rest } = customer;
  res.json(customerToJSON(rest));
});

// Dar de alta un cliente (requiere PIN)
router.post('/', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;

  const phone = normalizePhone(req.body?.phone);
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (phone.length < 10) return res.status(400).json({ error: 'Escribe un teléfono de 10 dígitos.' });

  if (getCustomer(business.id, phone)) return res.status(409).json({ error: 'Ese teléfono ya tiene una tarjeta.' });

  db.prepare(`
    INSERT INTO customers (business_id, phone, name, progress, redemptions, created_at)
    VALUES (?, ?, ?, 0, 0, ?)
  `).run(business.id, phone, name, new Date().toISOString());

  res.status(201).json(customerToJSON(getCustomer(business.id, phone)));
});

// Sumar sellos o puntos (requiere PIN)
router.post('/:phone/progress', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;

  const amount = Math.round(Number(req.body?.amount));
  if (!(amount > 0) || amount > 10000) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });

  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'Cliente no encontrado.' });

  db.transaction(() => {
    db.prepare('UPDATE customers SET progress = progress + ? WHERE id = ?').run(amount, customer.id);
    db.prepare('INSERT INTO history (customer_id, type, amount, created_at) VALUES (?, ?, ?, ?)')
      .run(customer.id, 'add', amount, new Date().toISOString());
  })();

  res.json(customerToJSON(getCustomer(business.id, customer.phone)));
});

// Canjear premio (requiere PIN)
router.post('/:phone/redeem', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;

  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const goal = goalFor(business);
  if (customer.progress < goal) {
    return res.status(400).json({ error: `Todavía no alcanza el premio (${customer.progress}/${goal}).` });
  }

  db.transaction(() => {
    db.prepare('UPDATE customers SET progress = progress - ?, redemptions = redemptions + 1 WHERE id = ?')
      .run(goal, customer.id);
    db.prepare('INSERT INTO history (customer_id, type, amount, created_at) VALUES (?, ?, ?, ?)')
      .run(customer.id, 'redeem', goal, new Date().toISOString());
  })();

  res.json(customerToJSON(getCustomer(business.id, customer.phone)));
});

module.exports = router;
