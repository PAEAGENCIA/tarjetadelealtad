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

db.DB_PATH = DB_PATH;
module.exports = db;
