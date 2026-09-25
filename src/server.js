require('dotenv').config();
const path = require('path');
const express = require('express');

const db = require('./db');
const { router: businessesRouter, adminRequired } = require('./routes/businesses');
const customersRouter = require('./routes/customers');
const walletRouter = require('./routes/wallet');
const { isAppleConfigured } = require('./services/appleWallet');
const { isGoogleConfigured } = require('./services/googleWallet');

const app = express();
app.set('trust proxy', 1); // Railway pone un proxy delante; así se ve la IP real de cada visitante.
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Lo que la interfaz necesita saber al abrir: si pide clave de administrador y si Wallet ya está activo.
app.get('/api/config', (req, res) => {
  res.json({
    adminRequired: adminRequired(),
    storageWarning: Boolean(process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR),
    wallet: { apple: isAppleConfigured(), google: isGoogleConfigured() }
  });
});

app.use('/api/businesses', businessesRouter);
app.use('/api/businesses/:slug/customers', customersRouter);
app.use('/api/businesses/:slug/wallet', walletRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// La interfaz (panel del negocio y vista del cliente)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos inválidos.' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vuelve corriendo en http://localhost:${PORT}`);
  console.log(`Base de datos: ${db.DB_PATH}`);
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
    console.log('AVISO: no hay volumen conectado. Los datos se BORRARÁN en cada despliegue. Agrega un volumen en /data.');
  }
  if (!adminRequired()) {
    console.log('Aviso: ADMIN_KEY no está configurada; cualquiera puede crear negocios.');
  }
});
