const fs = require('fs');
const { PKPass } = require('passkit-generator');
const { solidColorPNG } = require('./pngIcon');
const { goalFor } = require('../utils');

// Cada certificado puede venir como texto en una variable (ideal para Railway)
// o como ruta a un archivo .pem (ideal en tu computadora).
function readPem(textVar, pathVar) {
  const text = process.env[textVar];
  if (text && text.includes('-----BEGIN')) return Buffer.from(text.replace(/\\n/g, '\n'));
  const file = process.env[pathVar];
  if (file && fs.existsSync(file)) return fs.readFileSync(file);
  return null;
}

function appleCerts() {
  return {
    wwdr: readPem('APPLE_WWDR_CERT', 'APPLE_WWDR_CERT_PATH'),
    signerCert: readPem('APPLE_SIGNER_CERT', 'APPLE_SIGNER_CERT_PATH'),
    signerKey: readPem('APPLE_SIGNER_KEY', 'APPLE_SIGNER_KEY_PATH')
  };
}

function isAppleConfigured() {
  const c = appleCerts();
  return Boolean(
    process.env.APPLE_PASS_TYPE_IDENTIFIER &&
    process.env.APPLE_TEAM_IDENTIFIER &&
    c.wwdr && c.signerCert && c.signerKey
  );
}

function hexToRgbString(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// business: fila de la tabla businesses. customer: fila de la tabla customers.
async function generateApplePass(business, customer) {
  if (!isAppleConfigured()) {
    const err = new Error('Apple Wallet todavía no está activado.');
    err.code = 'APPLE_NOT_CONFIGURED';
    throw err;
  }

  const goal = goalFor(business);
  const unit = business.mechanic === 'sellos' ? 'SELLOS' : 'PUNTOS';
  const icon = solidColorPNG(29, business.color);
  const icon2x = solidColorPNG(58, business.color);

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: process.env.APPLE_PASS_TYPE_IDENTIFIER,
    teamIdentifier: process.env.APPLE_TEAM_IDENTIFIER,
    organizationName: business.name,
    description: `Tarjeta de lealtad de ${business.name}`,
    serialNumber: `${business.slug}-${customer.phone}`,
    backgroundColor: hexToRgbString(business.color),
    foregroundColor: 'rgb(255, 255, 255)',
    labelColor: 'rgb(255, 255, 255)',
    storeCard: {
      primaryFields: [
        { key: 'balance', label: unit, value: `${customer.progress}/${goal}` }
      ],
      secondaryFields: [
        { key: 'reward', label: 'PREMIO', value: business.reward_desc }
      ],
      auxiliaryFields: [
        { key: 'customer', label: 'CLIENTE', value: customer.name || customer.phone }
      ]
    },
    barcodes: [
      {
        message: `${business.slug}:${customer.phone}`,
        format: 'PKBarcodeFormatQR',
        messageEncoding: 'iso-8859-1'
      }
    ]
  };

  const pass = new PKPass(
    {
      'pass.json': Buffer.from(JSON.stringify(passJson)),
      'icon.png': icon,
      'icon@2x.png': icon2x
    },
    {
      ...appleCerts(),
      signerKeyPassphrase: process.env.APPLE_SIGNER_KEY_PASSPHRASE || undefined
    }
  );

  return pass.getAsBuffer();
}

module.exports = { isAppleConfigured, generateApplePass };
