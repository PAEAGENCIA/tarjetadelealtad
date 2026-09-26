const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { isBlocked, recordFailure, clearFailures, parseList, birthdayText, accessInfo, todayMx, addDays, isYmd } = require('../utils');
const { REASON_LABELS } = require('../promos');

// Sección solo para P.A.E.: ver todos los negocios y descargar el respaldo completo.
// Todo aquí requiere la clave de administrador (ADMIN_KEY).
const router = express.Router();

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireAdmin(req, res) {
  if (!process.env.ADMIN_KEY) {
    res.status(403).json({ error: 'Primero configura ADMIN_KEY en Railway.' });
    return false;
  }
  if (isBlocked(req, '__admin__')) {
    res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    return false;
  }
  if (!safeEqual(req.header('x-admin-key'), process.env.ADMIN_KEY)) {
    recordFailure(req, '__admin__');
    res.status(401).json({ error: 'La clave de administrador no es correcta.' });
    return false;
  }
  clearFailures(req, '__admin__');
  return true;
}

// Lista de negocios con sus números
router.get('/summary', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const businesses = db.prepare(`
    SELECT b.slug, b.name, b.color, b.plan, b.created_at AS createdAt, b.access_type, b.access_until,
      (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id AND c.status != 'pending') AS customers,
      (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id AND c.status = 'pending') AS pending,
      (SELECT COALESCE(SUM(h.amount), 0) FROM history h JOIN customers c ON c.id = h.customer_id
        WHERE c.business_id = b.id AND h.type = 'add') AS given,
      (SELECT COALESCE(SUM(c.redemptions), 0) FROM customers c WHERE c.business_id = b.id) AS redemptions
    FROM businesses b ORDER BY b.created_at DESC
  `).all().map(({ access_type, access_until, ...b }) => ({ ...b, access: accessInfo({ access_type, access_until }) }));
  res.json({ businesses, today: todayMx(), sheets: sheetsUrls(req) });
});

// Cambiar el plan de un negocio (Esencial / Premium). El diseño guardado nunca se borra.
router.put('/businesses/:slug/plan', express.json(), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const plan = req.body?.plan;
  if (!['esencial', 'premium'].includes(plan)) return res.status(400).json({ error: 'Plan inválido.' });
  const r = db.prepare('UPDATE businesses SET plan = ? WHERE slug = ?').run(plan, String(req.params.slug));
  if (!r.changes) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  res.json({ ok: true, plan });
});

// Vigencia del servicio.
//  { action: 'pay', days: 30 | 365 }      → suma días a partir de hoy o de la fecha vigente (lo que sea mayor), como pagado
//  { action: 'trial', days: 30 }          → prueba gratis desde hoy
//  { action: 'set', type, until }         → fecha exacta ('trial' o 'paid')
//  { action: 'none' }                     → sin fecha límite
router.put('/businesses/:slug/access', express.json(), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = db.prepare('SELECT id, access_type, access_until FROM businesses WHERE slug = ?').get(String(req.params.slug));
  if (!b) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  const { action } = req.body || {};
  const days = Math.max(1, Math.min(3660, Math.round(Number(req.body?.days) || 30)));
  let type = null, until = null;
  if (action === 'pay') {
    const today = todayMx();
    const from = b.access_until && b.access_until >= today ? addDays(b.access_until, 1) : today;
    type = 'paid'; until = addDays(from, days - 1);
  } else if (action === 'trial') {
    type = 'trial'; until = addDays(todayMx(), days - 1);
  } else if (action === 'set') {
    if (!isYmd(req.body?.until)) return res.status(400).json({ error: 'Fecha inválida.' });
    type = req.body?.type === 'paid' ? 'paid' : 'trial'; until = req.body.until;
  } else if (action !== 'none') {
    return res.status(400).json({ error: 'Acción inválida.' });
  }
  db.prepare('UPDATE businesses SET access_type = ?, access_until = ? WHERE id = ?').run(type, until, b.id);
  res.json({ ok: true, access: accessInfo({ access_type: type, access_until: until }) });
});

// Borrar un negocio para siempre, con todos sus clientes y su historial.
// Para evitar accidentes hay que mandar el código exacto del negocio en "confirm".
router.delete('/businesses/:slug', express.json(), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const slug = String(req.params.slug);
  const b = db.prepare('SELECT id FROM businesses WHERE slug = ?').get(slug);
  if (!b) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  if (String(req.body?.confirm || '').trim() !== slug) {
    return res.status(400).json({ error: 'Escribe el código exacto del negocio para confirmar.' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM history WHERE customer_id IN (SELECT id FROM customers WHERE business_id = ?)').run(b.id);
    db.prepare('DELETE FROM customers WHERE business_id = ?').run(b.id);
    db.prepare('DELETE FROM businesses WHERE id = ?').run(b.id);
  })();
  res.json({ ok: true });
});

// Restablecer el PIN del dueño cuando lo olvidó. Se genera uno nuevo de 6 dígitos al azar
// y todos los celulares con sesión abierta se salen solos.
router.put('/businesses/:slug/pin', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const business = db.prepare('SELECT id, staff_pin FROM businesses WHERE slug = ?').get(String(req.params.slug));
  if (!business) return res.status(404).json({ error: 'No encontramos ese negocio.' });
  let pin;
  do { pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (pin === business.staff_pin);
  db.prepare('UPDATE businesses SET pin = ? WHERE id = ?').run(pin, business.id);
  res.json({ ok: true, pin });
});

/* ---------- Google Sheets ----------
   Google Sheets lee estas ligas con la fórmula IMPORTDATA y se actualiza solo.
   Usan una clave aparte (SHEETS_KEY) que solo permite LEER: aunque alguien la viera,
   no podría crear negocios ni tocar tarjetas. */

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function sheetsUrls(req) {
  if (!process.env.SHEETS_KEY) return null;
  const k = encodeURIComponent(process.env.SHEETS_KEY);
  return {
    negocios: `${baseUrl(req)}/api/admin/sheets/negocios.csv?key=${k}`,
    clientes: `${baseUrl(req)}/api/admin/sheets/clientes.csv?key=${k}`,
    visitas: `${baseUrl(req)}/api/admin/sheets/visitas.csv?key=${k}`
  };
}

function requireSheetsKey(req, res) {
  if (!process.env.SHEETS_KEY) {
    res.status(403).type('text/plain').send('Falta configurar SHEETS_KEY en Railway.');
    return false;
  }
  if (isBlocked(req, '__sheets__')) {
    res.status(429).type('text/plain').send('Demasiados intentos.');
    return false;
  }
  if (!safeEqual(req.query.key, process.env.SHEETS_KEY)) {
    recordFailure(req, '__sheets__');
    res.status(401).type('text/plain').send('Clave incorrecta.');
    return false;
  }
  clearFailures(req, '__sheets__');
  return true;
}

// Celda de CSV segura: entre comillas, y sin que un texto que empiece con "=" se vuelva fórmula.
function cell(value) {
  let t = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(t)) t = ' ' + t;
  return '"' + t.replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
}

function fecha(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(iso);
  // Hora de la Ciudad de México
  return d.toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' }).slice(0, 16);
}

function vigenciaText(a) {
  if (a.type === 'none') return 'Sin fecha límite';
  const tipo = a.type === 'paid' ? 'Pagado' : 'Prueba';
  return a.expired ? `${tipo} · vencido el ${a.until}` : `${tipo} hasta ${a.until} (${a.daysLeft} días)`;
}

function sendCsv(res, header, rows) {
  const lines = [header.map(cell).join(',')].concat(rows.map(r => r.map(cell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(lines.join('\r\n'));
}

router.get('/sheets/negocios.csv', (req, res) => {
  if (!requireSheetsKey(req, res)) return;
  const rows = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id AND c.status != 'pending') AS activos,
      (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id AND c.status = 'pending') AS pendientes,
      (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id AND c.marketing_opt_in = 1) AS promos,
      (SELECT COALESCE(SUM(h.amount), 0) FROM history h JOIN customers c ON c.id = h.customer_id
        WHERE c.business_id = b.id AND h.type = 'add') AS dados,
      (SELECT COALESCE(SUM(c.redemptions), 0) FROM customers c WHERE c.business_id = b.id) AS canjes,
      (SELECT MAX(h.created_at) FROM history h JOIN customers c ON c.id = h.customer_id
        WHERE c.business_id = b.id) AS ultima
    FROM businesses b ORDER BY b.created_at ASC
  `).all();
  sendCsv(res,
    ['Negocio', 'Código', 'Plan', 'Vigencia', 'Mecánica', 'Meta', 'Premio', 'Productos', 'Clientes activos', 'Solicitudes pendientes',
      'Aceptan promociones', 'Sellos o puntos dados', 'Premios canjeados', 'Última actividad', 'Fecha de alta', 'Liga para clientes'],
    rows.map(b => [
      b.name, b.slug, b.plan === 'premium' ? 'Premium' : 'Esencial', vigenciaText(accessInfo(b)), b.mechanic === 'sellos' ? 'Sellos' : 'Puntos',
      b.mechanic === 'sellos' ? b.stamps_goal : b.points_goal, b.reward_desc, parseList(b.products).join(' / '),
      b.activos, b.pendientes, b.promos, b.dados, b.canjes, fecha(b.ultima), fecha(b.created_at),
      `${baseUrl(req)}/?n=${b.slug}`
    ]));
});

router.get('/sheets/clientes.csv', (req, res) => {
  if (!requireSheetsKey(req, res)) return;
  const rows = db.prepare(`
    SELECT c.*, b.name AS negocio, b.slug, b.mechanic, b.stamps_goal, b.points_goal,
      (SELECT COALESCE(SUM(h.amount), 0) FROM history h WHERE h.customer_id = c.id AND h.type = 'add') AS dados,
      (SELECT MAX(h.created_at) FROM history h WHERE h.customer_id = c.id) AS ultima
    FROM customers c JOIN businesses b ON b.id = c.business_id
    ORDER BY b.name ASC, c.created_at ASC
  `).all();
  sendCsv(res,
    ['Negocio', 'Código negocio', 'Nombre', 'Teléfono', 'Correo', 'Cumpleaños', 'Productos favoritos', 'Acepta promociones',
      'Estado', 'Avance actual', 'Meta', 'Total dado', 'Premios canjeados', 'Última visita', 'Fecha de registro'],
    rows.map(c => [
      c.negocio, c.slug, c.name, c.phone, c.email || '', birthdayText(c.birthday), parseList(c.favorites).join(' / '),
      c.marketing_opt_in ? 'Sí' : 'No', c.status === 'pending' ? 'Solicitud pendiente' : 'Activo',
      c.progress, c.mechanic === 'sellos' ? c.stamps_goal : c.points_goal, c.dados, c.redemptions,
      fecha(c.ultima), fecha(c.created_at)
    ]));
});

// Copia exacta de toda la base de datos (todos los negocios y clientes)
router.get('/backup', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const tmp = path.join(os.tmpdir(), `vuelve-respaldo-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    const day = new Date().toISOString().slice(0, 10);
    res.download(tmp, `vuelve-respaldo-${day}.db`, () => fs.unlink(tmp, () => {}));
  } catch (err) {
    console.error(err);
    fs.unlink(tmp, () => {});
    res.status(500).json({ error: 'No se pudo generar el respaldo.' });
  }
});

// Cada sello y cada canje, con fecha, hora y productos (lo más reciente primero)
router.get('/sheets/visitas.csv', (req, res) => {
  if (!requireSheetsKey(req, res)) return;
  const rows = db.prepare(`
    SELECT h.type, h.amount, h.products, h.created_at, h.reason, c.name, c.phone, b.name AS negocio, b.slug, b.mechanic
    FROM history h JOIN customers c ON c.id = h.customer_id JOIN businesses b ON b.id = c.business_id
    ORDER BY h.id DESC LIMIT 20000
  `).all();
  sendCsv(res,
    ['Fecha y hora', 'Negocio', 'Código negocio', 'Cliente', 'Teléfono', 'Movimiento', 'Cantidad', 'Productos comprados'],
    rows.map(h => [
      fecha(h.created_at), h.negocio, h.slug, h.name, h.phone,
      h.type === 'redeem' ? 'Canjeó premio' : ((h.mechanic === 'sellos' ? 'Sello' : 'Puntos') + (h.reason ? ` (${REASON_LABELS[h.reason] || h.reason})` : '')),
      h.type === 'redeem' ? -h.amount : h.amount, parseList(h.products).join(' / ')
    ]));
});

module.exports = router;
