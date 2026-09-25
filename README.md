# Vuelve

Tarjetas de lealtad digitales para negocios: panel del negocio, vista del cliente y (cuando se activen) Apple Wallet y Google Wallet.

## Qué hay en esta carpeta

| Carpeta o archivo | Qué es |
| --- | --- |
| `public/index.html` | La interfaz: lo que ven el negocio y el cliente |
| `src/` | El servidor: guarda negocios, clientes, sellos y canjes |
| `railway.json` | Le dice a Railway cómo arrancar y revisar que la app esté viva |
| `.env.example` | Lista de variables (clave de administrador, Apple, Google) |
| `certs/` | Aquí van los certificados de Apple si corres la app en tu computadora |

## Variables en Railway

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `ADMIN_KEY` | Sí | Clave secreta para dar de alta negocios. Sin ella, cualquiera podría crear negocios |
| Volumen montado en `/data` | Sí | Disco donde se guardan los datos. Sin él, se borran en cada actualización |

Las variables de Apple y Google Wallet se agregan después; están en `.env.example`.

## Correrla en tu computadora (opcional)

```bash
npm install
npm start
```

Abre http://localhost:3000

## Liga para clientes

Cada negocio tiene una liga como `https://TU-DOMINIO/?n=codigo-del-negocio`. Esa liga va en el QR del mostrador: el cliente la abre, escribe su teléfono y ve su tarjeta. La segunda vez entra directo.
