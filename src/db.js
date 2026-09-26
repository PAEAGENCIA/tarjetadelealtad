const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// En Railway, al conectar un volumen, RAILWAY_VOLUME_MOUNT_PATH apunta al disco persistente.
// En tu computadora, los datos se guardan en la carpeta ./data del proyecto.
const DATA_DIR =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'vuelve.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    pin TEXT NOT NULL,
    mechanic TEXT NOT NULL CHECK(mechanic IN ('sellos','puntos')),
    stamps_goal INTEGER,
    points_goal INTEGER,
    points_per_visit INTEGER,
    reward_desc TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    name TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    redemptions INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(business_id, phone)
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('add','redeem')),
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Migración: las bases creadas antes de las solicitudes no tienen la columna "status".
// Los clientes que ya existían quedan como activos.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('customers', 'status', "TEXT NOT NULL DEFAULT 'active'");
addColumnIfMissing('customers', 'email', 'TEXT');
addColumnIfMissing('customers', 'favorites', "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('customers', 'marketing_opt_in', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('customers', 'privacy_accepted_at', 'TEXT');
addColumnIfMissing('businesses', 'products', "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('history', 'products', "TEXT NOT NULL DEFAULT '[]'");

// Planes y diseño Premium. Los negocios que ya existían (piloto) quedan en Premium
// para que no pierdan funciones que ya estaban usando.
const hadPlan = db.prepare('PRAGMA table_info(businesses)').all().some(c => c.name === 'plan');
addColumnIfMissing('businesses', 'plan', "TEXT NOT NULL DEFAULT 'esencial'");
if (!hadPlan) db.exec("UPDATE businesses SET plan = 'premium'");
addColumnIfMissing('businesses', 'logo', 'TEXT');                 // imagen en base64 (PNG/JPG/WEBP, máx. ~200 KB)
addColumnIfMissing('businesses', 'logo_version', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('businesses', 'stamp_icon', "TEXT NOT NULL DEFAULT 'check'");
addColumnIfMissing('businesses', 'card_title', 'TEXT');
addColumnIfMissing('businesses', 'card_style', "TEXT NOT NULL DEFAULT 'gradient'");

// Seguridad: PIN del personal (opcional) y una clave secreta por cliente para que
// solo él (desde su liga) y el negocio puedan ver su avance.
addColumnIfMissing('businesses', 'staff_pin', 'TEXT');
addColumnIfMissing('customers', 'card_token', 'TEXT');
// Vigencia del servicio: 'trial' (prueba) o 'paid' (pagado) hasta una fecha 'YYYY-MM-DD'.
// Sin fecha = sin límite (así quedan los negocios que ya existían).
addColumnIfMissing('businesses', 'access_type', 'TEXT');
addColumnIfMissing('businesses', 'access_until', 'TEXT');
addColumnIfMissing('customers', 'birthday', 'TEXT');   // 'MM-DD' (día y mes, sin año): con esto el cliente abre su tarjeta desde cualquier celular
{
  const crypto = require('crypto');
  const missing = db.prepare('SELECT id FROM customers WHERE card_token IS NULL').all();
  const setToken = db.prepare('UPDATE customers SET card_token = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of missing) setToken.run(crypto.randomBytes(18).toString('base64url'), row.id);
  })();
}

// Premium: dinámicas de promociones, quién invitó a cada cliente y el motivo de sellos de regalo.
addColumnIfMissing('businesses', 'promos', "TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing('customers', 'referred_by', 'TEXT');
addColumnIfMissing('history', 'reason', 'TEXT');   // NULL = visita normal; 'doble' | 'bienvenida' | 'referido' | 'regalo'

db.DB_PATH = DB_PATH;
module.exports = db;
