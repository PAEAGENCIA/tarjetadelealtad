const express = require('express');
const db = require('../db');
const { slugify, normalizePhone } = require('../utils');
const { isAppleConfigured, generateApplePass } = require('../services/appleWallet');
const { isGoogleConfigured, generateGoogleSaveLink } = require('../services/googleWallet');

const router = express.Router({ mergeParams: true });

function getBusinessAndCustomer(slug, phone) {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slugify(slug));
  if (!business) return { error: 'No encontramos ese negocio.', status: 404 };
  const customer = db.prepare('SELECT * FROM customers WHERE business_id = ? AND phone = ?').get(business.id, normalizePhone(phone));
  if (!customer) return { error: 'No encontramos esa tarjeta.', status: 404 };
  return { business, customer };
}

router.get('/status', (req, res) => {
  res.json({ apple: isAppleConfigured(), google: isGoogleConfigured() });
});

router.get('/apple/:phone', async (req, res) => {
  const { business, customer, error, status } = getBusinessAndCustomer(req.params.slug, req.params.phone);
  if (error) return res.status(status).json({ error });

  try {
    const buffer = await generateApplePass(business, customer);
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', `attachment; filename="${business.slug}.pkpass"`);
    res.send(buffer);
  } catch (err) {
    if (err.code === 'APPLE_NOT_CONFIGURED') {
      return res.status(501).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo generar el pase de Apple Wallet.' });
  }
});

router.get('/google/:phone', async (req, res) => {
  const { business, customer, error, status } = getBusinessAndCustomer(req.params.slug, req.params.phone);
  if (error) return res.status(status).json({ error });

  try {
    const url = await generateGoogleSaveLink(business, customer);
    res.json({ url });
  } catch (err) {
    if (err.code === 'GOOGLE_NOT_CONFIGURED') {
      return res.status(501).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo generar el enlace de Google Wallet.' });
  }
});

module.exports = router;
