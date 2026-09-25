const express = require('express');
const db = require('../db');
const {
  slugify, normalizePhone, goalFor, customerToJSON, customerPrivateJSON,
  overLimit, parseList, cleanList, isEmail
} = require('../utils');
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
  res.json(rows.map(customerPrivateJSON));
});

// Descargar la base de clientes en CSV (se abre en Excel o Google Sheets). Requiere PIN.
function csvCell(value) {
  let t = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // evita que Excel ejecute fórmulas escondidas en un dato
  return '"' + t.replace(/"/g, '""') + '"';
}
router.get('/export.csv', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;

  const unit = business.mechanic === 'sellos' ? 'Sellos' : 'Puntos';
  const rows = db.prepare(`${WITH_GIVEN} WHERE c.business_id = ? ORDER BY c.created_at ASC`).all(business.id);
  const header = ['Nombre', 'Teléfono', 'Correo', 'Productos favoritos', 'Acepta promociones', 'Estado',
    `${unit} actuales`, `${unit} dados en total`, 'Premios canjeados', 'Fecha de registro'];
  const lines = [header.map(csvCell).join(',')];
  for (const c of rows) {
    lines.push([
      c.name, c.phone, c.email || '', parseList(c.favorites).join(' / '),
      c.marketing_opt_in ? 'Sí' : 'No', c.status === 'pending' ? 'Solicitud pendiente' : 'Activo',
      c.progress, c.given, c.redemptions, String(c.created_at || '').slice(0, 10)
    ].map(csvCell).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="clientes-${business.slug}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
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
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (phone.length < 10) return res.status(400).json({ error: 'Escribe un teléfono de 10 dígitos.' });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'Ese correo no parece válido.' });

  const existing = getCustomer(business.id, phone);
  if (existing && existing.status === 'pending') {
    db.prepare(`UPDATE customers SET status = 'active', name = COALESCE(NULLIF(?, ''), name),
      email = COALESCE(NULLIF(?, ''), email) WHERE id = ?`).run(name, email, existing.id);
    return res.status(200).json(customerPrivateJSON(getCustomer(business.id, phone)));
  }
  if (existing) return res.status(409).json({ error: 'Ese teléfono ya tiene una tarjeta.' });

  db.prepare(`
    INSERT INTO customers (business_id, phone, name, email, progress, redemptions, created_at, status)
    VALUES (?, ?, ?, ?, 0, 0, ?, 'active')
  `).run(business.id, phone, name, email || null, new Date().toISOString());

  res.status(201).json(customerPrivateJSON(getCustomer(business.id, phone)));
});

// El cliente pide su tarjeta desde su celular (pública). Queda pendiente hasta que el negocio la apruebe.
router.post('/request', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (overLimit(req, 'request', 40, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes desde esta conexión. Intenta más tarde.' });
  }

  const phone = normalizePhone(req.body?.phone);
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (phone.length !== 10) return res.status(400).json({ error: 'Escribe tu teléfono de 10 dígitos.' });
  if (!name) return res.status(400).json({ error: 'Escribe tu nombre para que el negocio te reconozca.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Escribe un correo válido.' });
  if (req.body?.privacyAccepted !== true) return res.status(400).json({ error: 'Para crear tu tarjeta necesitas aceptar el aviso de privacidad.' });

  // Si el negocio tiene su lista de productos, solo se guardan favoritos de esa lista.
  let favorites = cleanList(req.body?.favorites, 5, 30);
  const products = parseList(business.products);
  if (products.length) {
    const allowed = new Map(products.map(p => [p.toLowerCase(), p]));
    favorites = favorites.map(f => allowed.get(f.toLowerCase())).filter(Boolean);
  }

  const existing = getCustomer(business.id, phone);
  if (existing) {
    const { given, ...rest } = existing;
    return res.status(200).json(customerToJSON(rest));
  }

  db.prepare(`
    INSERT INTO customers (business_id, phone, name, email, favorites, marketing_opt_in, privacy_accepted_at,
      progress, redemptions, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'pending')
  `).run(business.id, phone, name, email, JSON.stringify(favorites), req.body?.marketingOptIn === true ? 1 : 0,
    new Date().toISOString(), new Date().toISOString());

  const { given, ...created } = getCustomer(business.id, phone);
  res.status(201).json(customerToJSON(created));
});

// Aprobar una solicitud (requiere PIN)
router.post('/:phone/approve', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;

  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'Esa solicitud ya no existe.' });
  db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(customer.id);
  res.json(customerPrivateJSON(getCustomer(business.id, customer.phone)));
});

// Rechazar una solicitud pendiente (requiere PIN). Solo borra solicitudes, nunca tarjetas activas.
router.delete('/:phone', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;

  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'Esa solicitud ya no existe.' });
  if (customer.status !== 'pending') return res.status(400).json({ error: 'Solo se pueden rechazar solicitudes pendientes.' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id);
  res.json({ ok: true });
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
  if (customer.status === 'pending') return res.status(400).json({ error: 'Primero aprueba la solicitud de este cliente.' });

  db.transaction(() => {
    db.prepare('UPDATE customers SET progress = progress + ? WHERE id = ?').run(amount, customer.id);
    db.prepare('INSERT INTO history (customer_id, type, amount, created_at) VALUES (?, ?, ?, ?)')
      .run(customer.id, 'add', amount, new Date().toISOString());
  })();

  res.json(customerPrivateJSON(getCustomer(business.id, customer.phone)));
});

// Canjear premio (requiere PIN)
router.post('/:phone/redeem', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;

  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'Cliente no encontrado.' });
  if (customer.status === 'pending') return res.status(400).json({ error: 'Primero aprueba la solicitud de este cliente.' });

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

  res.json(customerPrivateJSON(getCustomer(business.id, customer.phone)));
});

module.exports = router;
