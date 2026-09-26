const { GoogleAuth } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { goalFor } = require('../utils');

const WALLET_API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';

function isGoogleConfigured() {
  return Boolean(
    process.env.GOOGLE_ISSUER_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  );
}

function getPrivateKey() {
  // En el .env las llaves privadas se pegan con saltos de línea escapados (\n)
  return process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n');
}

function sanitizeId(str) {
  return String(str).replace(/[^A-Za-z0-9_.-]/g, '-');
}

function classIdFor(business) {
  return `${process.env.GOOGLE_ISSUER_ID}.${sanitizeId(business.slug)}`;
}

function objectIdFor(business, customer) {
  return `${process.env.GOOGLE_ISSUER_ID}.${sanitizeId(business.slug)}-${sanitizeId(customer.phone)}`;
}

async function getAccessToken() {
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: getPrivateKey()
    },
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer']
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

// Se crea una sola vez por negocio (Google la reutiliza si ya existe)
async function ensureLoyaltyClass(business) {
  const token = await getAccessToken();
  const classId = classIdFor(business);

  const check = await fetch(`${WALLET_API_BASE}/loyaltyClass/${classId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (check.status === 200) return classId;

  const createRes = await fetch(`${WALLET_API_BASE}/loyaltyClass`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: classId,
      issuerName: business.name,
      programName: business.name,
      reviewStatus: 'UNDER_REVIEW',
      hexBackgroundColor: business.color
    })
  });
  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text();
    throw new Error(`No se pudo crear la clase de Google Wallet (${createRes.status}): ${text}`);
  }
  return classId;
}

// Devuelve la liga "Guardar en Google Wallet" (crea el objeto al vuelo vía el JWT)
async function generateGoogleSaveLink(business, customer) {
  if (!isGoogleConfigured()) {
    const err = new Error('Google Wallet todavía no está activado.');
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }

  const classId = await ensureLoyaltyClass(business);
  const goal = goalFor(business);
  const unit = business.mechanic === 'sellos' ? 'Sellos' : 'Puntos';

  const loyaltyObject = {
    id: objectIdFor(business, customer),
    classId,
    state: 'ACTIVE',
    accountName: customer.name || customer.phone,
    accountId: customer.phone,
    loyaltyPoints: {
      label: unit,
      balance: { string: `${customer.progress}/${goal}` }
    },
    barcode: {
      type: 'QR_CODE',
      value: `${business.slug}:${customer.phone}`
    },
    textModulesData: [
      { header: 'Premio', body: business.reward_desc }
    ]
  };

  const payload = {
    iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { loyaltyObjects: [loyaltyObject] }
  };

  const token = jwt.sign(payload, getPrivateKey(), { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

module.exports = { isGoogleConfigured, generateGoogleSaveLink };
