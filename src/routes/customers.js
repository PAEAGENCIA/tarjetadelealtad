const express = require('express');
const db = require('../db');
const {
  slugify, normalizePhone, goalFor, customerToJSON, customerPrivateJSON,
  customerPublicJSON, customerStaffJSON, newCardToken, parseBirthday, birthdayText,
  isBlocked, recordFailure, clearFailures,
  overLimit, parseList, cleanList, isEmail, isPremium
} = require('../utils');
const { requirePin, requireOwner, safeEqual } = require('./businesses');
const { parsePromos, globalDoubles, personalDoubles, nowMx, REASON_LABELS } = require('../promos');

// Última visita "real" (sin contar sellos de regalo)
function lastVisit(customerId) {
  return db.prepare("SELECT MAX(created_at) AS at FROM history WHERE customer_id = ? AND type = 'add' AND reason IS NULL").get(customerId).at;
}
function unitFor(business) { return business.mechanic === 'sellos' ? 1 : (business.points_per_visit || 1); }

// Da sellos de regalo (bienvenida, doble, invitación…) y los deja en el historial con su motivo.
function giveBonus(customerId, amount, reason) {
  db.prepare('UPDATE customers SET progress = progress + ? WHERE id = ?').run(amount, customerId);
  db.prepare("INSERT INTO history (customer_id, type, amount, products, created_at, reason) VALUES (?, 'add', ?, '[]', ?, ?)")
    .run(customerId, amount, new Date().toISOString(), reason);
}

// Sello de bienvenida: solo si la promoción está prendida y el cliente aún no tiene movimientos.
function welcomeBonus(business, customer) {
  if (!isPremium(business) || !parsePromos(business.promos).welcome.on) return 0;
  const any = db.prepare('SELECT 1 FROM history WHERE customer_id = ? LIMIT 1').get(customer.id);
  if (any) return 0;
  const amount = unitFor(business);
  giveBonus(customer.id, amount, 'bienvenida');
  return amount;
}

// El dueño ve todo; el personal ve avance y liga de la tarjeta, sin correo ni favoritos.
function forRole(role, row) {
  return role === 'owner' ? customerPrivateJSON(row) : customerStaffJSON(row);
}

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
  const role = requirePin(req, res, business);
  if (!role) return;

  const rows = db.prepare(`${WITH_GIVEN} WHERE c.business_id = ? ORDER BY c.created_at DESC`).all(business.id);
  res.json(rows.map(r => forRole(role, r)));
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
  // Aunque el periodo haya terminado, el dueño siempre puede descargar la información de sus clientes.
  if (!requireOwner(req, res, business, { allowExpired: true })) return;

  const unit = business.mechanic === 'sellos' ? 'Sellos' : 'Puntos';
  const rows = db.prepare(`${WITH_GIVEN} WHERE c.business_id = ? ORDER BY c.created_at ASC`).all(business.id);
  const header = ['Nombre', 'Teléfono', 'Correo', 'Cumpleaños', 'Productos favoritos', 'Acepta promociones', 'Estado',
    `${unit} actuales`, `${unit} dados en total`, 'Premios canjeados', 'Fecha de registro'];
  const lines = [header.map(csvCell).join(',')];
  for (const c of rows) {
    lines.push([
      c.name, c.phone, c.email || '', birthdayText(c.birthday), parseList(c.favorites).join(' / '),
      c.marketing_opt_in ? 'Sí' : 'No', c.status === 'pending' ? 'Solicitud pendiente' : 'Activo',
      c.progress, c.given, c.redemptions, String(c.created_at || '').slice(0, 10)
    ].map(csvCell).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="clientes-${business.slug}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
});

// Ver la tarjeta de un cliente (vista "Ver mi tarjeta").
// Con la clave de su liga (x-card-token) ve su avance completo.
// Sin la clave, solo se confirma que la tarjeta existe y su primer nombre: nadie más ve sus sellos.
router.get('/:phone', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  const token = req.header('x-card-token');
  if (!token && overLimit(req, 'lookup', 60, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiadas búsquedas desde esta conexión. Intenta más tarde.' });
  }
  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'no_card' });
  if (token && customer.card_token && safeEqual(token, customer.card_token)) {
    const { given, ...rest } = customer;
    const out = customerToJSON(rest);
    if (isPremium(business)) out.promoForYou = personalDoubles(parsePromos(business.promos), customer, lastVisit(customer.id));
    return res.json(out);
  }
  res.json(customerPublicJSON(customer));
});

// Dar de alta un cliente (requiere PIN)
router.post('/', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  const role = requirePin(req, res, business);
  if (!role) return;

  const phone = normalizePhone(req.body?.phone);
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (phone.length < 10) return res.status(400).json({ error: 'Escribe un teléfono de 10 dígitos.' });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'Ese correo no parece válido.' });
  const birthday = req.body?.birthday ? parseBirthday(req.body.birthday) : null;
  if (req.body?.birthday && !birthday) return res.status(400).json({ error: 'Esa fecha de cumpleaños no existe.' });

  const existing = getCustomer(business.id, phone);
  if (existing && existing.status === 'pending') {
    db.prepare(`UPDATE customers SET status = 'active', name = COALESCE(NULLIF(?, ''), name),
      email = COALESCE(NULLIF(?, ''), email) WHERE id = ?`).run(name, email, existing.id);
    const welcome = welcomeBonus(business, existing);
    return res.status(200).json({ ...forRole(role, getCustomer(business.id, phone)), bonus: welcome ? { amount: welcome, reasons: ['Sello de bienvenida'] } : null });
  }
  if (existing) return res.status(409).json({ error: 'Ese teléfono ya tiene una tarjeta.' });

  db.prepare(`
    INSERT INTO customers (business_id, phone, name, email, progress, redemptions, created_at, status, card_token, birthday, marketing_opt_in)
    VALUES (?, ?, ?, ?, 0, 0, ?, 'active', ?, ?, ?)
  `).run(business.id, phone, name, email || null, new Date().toISOString(), newCardToken(), birthday, req.body?.marketingOptIn === true ? 1 : 0);
  const created = getCustomer(business.id, phone);
  const welcome = welcomeBonus(business, created);

  res.status(201).json({ ...forRole(role, getCustomer(business.id, phone)), bonus: welcome ? { amount: welcome, reasons: ['Sello de bienvenida'] } : null });
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
  const birthday = parseBirthday(req.body?.birthday);
  if (!birthday) return res.status(400).json({ error: 'Elige el día y el mes de tu cumpleaños.' });
  if (req.body?.privacyAccepted !== true) return res.status(400).json({ error: 'Para crear tu tarjeta necesitas aceptar el aviso de privacidad.' });

  // Si el negocio tiene su lista de productos, solo se guardan favoritos de esa lista.
  let favorites = isPremium(business) ? cleanList(req.body?.favorites, 5, 30) : [];
  const products = parseList(business.products);
  if (products.length) {
    const allowed = new Map(products.map(p => [p.toLowerCase(), p]));
    favorites = favorites.map(f => allowed.get(f.toLowerCase())).filter(Boolean);
  }

  // Si ese teléfono ya tiene tarjeta, no se entrega su liga: así nadie puede "pedir" la tarjeta de otra persona.
  const existing = getCustomer(business.id, phone);
  if (existing) {
    return res.status(409).json({ code: 'exists', error: 'Ese teléfono ya tiene tarjeta en este negocio.', ...customerPublicJSON(existing) });
  }

  // Invita a un amigo: guardamos quién lo invitó (el sello se le da cuando este cliente haga su primera compra).
  let referredBy = normalizePhone(req.body?.referredBy);
  if (!(isPremium(business) && parsePromos(business.promos).referral.on && referredBy.length === 10 && referredBy !== phone)) referredBy = null;

  const token = newCardToken();
  db.prepare(`
    INSERT INTO customers (business_id, phone, name, email, favorites, marketing_opt_in, privacy_accepted_at,
      progress, redemptions, created_at, status, card_token, birthday, referred_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'pending', ?, ?, ?)
  `).run(business.id, phone, name, email, JSON.stringify(favorites), req.body?.marketingOptIn === true ? 1 : 0,
    new Date().toISOString(), new Date().toISOString(), token, birthday, referredBy);

  const { given, ...created } = getCustomer(business.id, phone);
  res.status(201).json({ ...customerToJSON(created), cardToken: token });
});

// Abrir la tarjeta desde cualquier celular con teléfono + cumpleaños (pública).
// Si coincide, se entrega la clave de su tarjeta para que ese celular la recuerde.
// Freno: 10 intentos fallidos por tarjeta cada 15 minutos, y 30 intentos por hora desde una conexión.
router.post('/:phone/unlock', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  const phone = normalizePhone(req.params.phone);
  const key = `card:${business.slug}:${phone}`;
  if (isBlocked(req, key) || overLimit(req, 'unlock', 30, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos o pide ayuda en caja.' });
  }
  const customer = getCustomer(business.id, phone);
  if (!customer) return res.status(404).json({ error: 'no_card' });
  if (!customer.birthday) {
    return res.status(400).json({ code: 'no_birthday', error: 'Tu tarjeta aún no tiene cumpleaños registrado. Pide en caja que lo agreguen o que te envíen tu tarjeta por WhatsApp.' });
  }
  const birthday = parseBirthday(req.body?.birthday);
  if (!birthday || birthday !== customer.birthday) {
    recordFailure(req, key);
    return res.status(401).json({ error: 'El cumpleaños no coincide con esta tarjeta.' });
  }
  clearFailures(req, key);
  const { given, ...rest } = customer;
  res.json({ ...customerToJSON(rest), cardToken: customer.card_token });
});

// Guardar o corregir el cumpleaños: el negocio (con PIN) o el propio cliente (con la clave de su tarjeta).
router.put('/:phone/birthday', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  const token = req.header('x-card-token');
  let role = null;
  if (token) {
    if (!customer || !customer.card_token || !safeEqual(token, customer.card_token)) return res.status(404).json({ error: 'No encontramos esa tarjeta.' });
  } else {
    role = requirePin(req, res, business);
    if (!role) return;
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado.' });
  }
  const birthday = parseBirthday(req.body?.birthday);
  if (!birthday) return res.status(400).json({ error: 'Elige un día y mes válidos.' });
  db.prepare('UPDATE customers SET birthday = ? WHERE id = ?').run(birthday, customer.id);
  const updated = getCustomer(business.id, customer.phone);
  if (role) return res.json(forRole(role, updated));
  const { given, ...rest } = updated;
  res.json(customerToJSON(rest));
});

// Historial de visitas de un cliente: fecha y hora de cada sello o canje, y lo que compró (requiere PIN)
router.get('/:phone/history', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (!requirePin(req, res, business)) return;
  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'Cliente no encontrado.' });
  const rows = db.prepare('SELECT type, amount, products, created_at, reason FROM history WHERE customer_id = ? ORDER BY id DESC LIMIT 50')
    .all(customer.id);
  res.json(rows.map(r => ({ type: r.type, amount: r.amount, products: parseList(r.products), at: r.created_at, reason: r.reason || null, reasonLabel: r.reason ? (REASON_LABELS[r.reason] || r.reason) : null })));
});

// Aprobar una solicitud (requiere PIN)
router.post('/:phone/approve', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  const role = requirePin(req, res, business);
  if (!role) return;

  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'Esa solicitud ya no existe.' });
  db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(customer.id);
  const welcome = welcomeBonus(business, customer);
  res.json({ ...forRole(role, getCustomer(business.id, customer.phone)), bonus: welcome ? { amount: welcome, reasons: ['Sello de bienvenida'] } : null });
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
  const role = requirePin(req, res, business);
  if (!role) return;

  const amount = Math.round(Number(req.body?.amount));
  if (!(amount > 0) || amount > 10000) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });

  // Productos que compró en esta visita (opcional). Solo se aceptan los de la lista del negocio.
  let bought = isPremium(business) ? cleanList(req.body?.products, 10, 30) : [];
  const catalog = parseList(business.products);
  if (catalog.length) {
    const allowed = new Map(catalog.map(p => [p.toLowerCase(), p]));
    bought = bought.map(p => allowed.get(p.toLowerCase())).filter(Boolean);
  }

  const customer = getCustomer(business.id, normalizePhone(req.params.phone));
  if (!customer) return res.status(404).json({ error: 'Cliente no encontrado.' });
  if (customer.status === 'pending') return res.status(400).json({ error: 'Primero aprueba la solicitud de este cliente.' });

  // Regalo del negocio (ej. por su cumpleaños): no cuenta como visita ni activa promociones.
  if (req.body?.gift === true) {
    if (!isPremium(business)) return res.status(403).json({ error: 'Esta función es del plan Premium.' });
    db.transaction(() => giveBonus(customer.id, amount, 'regalo'))();
    return res.json({ ...forRole(role, getCustomer(business.id, customer.phone)), bonus: { amount, reasons: ['Regalo del negocio'] }, gift: true });
  }

  const promos = isPremium(business) ? parsePromos(business.promos) : null;
  const previous = lastVisit(customer.id);
  const now = nowMx();
  const reasons = promos ? [...globalDoubles(promos, now), ...personalDoubles(promos, customer, previous, now)] : [];
  let referrer = null;
  if (promos && promos.referral.on && !previous && customer.referred_by) {
    const r = db.prepare("SELECT * FROM customers WHERE business_id = ? AND phone = ? AND status = 'active'").get(business.id, customer.referred_by);
    if (r && r.id !== customer.id) referrer = r;
  }

  db.transaction(() => {
    db.prepare('UPDATE customers SET progress = progress + ? WHERE id = ?').run(amount, customer.id);
    db.prepare('INSERT INTO history (customer_id, type, amount, products, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(customer.id, 'add', amount, JSON.stringify(bought), new Date().toISOString());
    if (reasons.length) giveBonus(customer.id, amount, 'doble');                  // la promoción duplica lo de esta visita
    if (referrer) giveBonus(referrer.id, unitFor(business), 'referido');          // quien lo invitó gana su sello
  })();

  const out = forRole(role, getCustomer(business.id, customer.phone));
  out.bonus = reasons.length ? { amount, reasons } : null;
  if (referrer) out.referrer = { name: referrer.name || referrer.phone, phone: referrer.phone, amount: unitFor(business) };
  res.json(out);
});

// Canjear premio (requiere PIN)
router.post('/:phone/redeem', (req, res) => {
  const business = getBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  const role = requirePin(req, res, business);
  if (!role) return;

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

  res.json(forRole(role, getCustomer(business.id, customer.phone)));
});

module.exports = router;
