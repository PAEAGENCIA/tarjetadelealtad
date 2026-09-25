# Certificados de Apple Wallet

Esta carpeta está vacía a propósito. El servidor funciona sin nada aquí —
solo los botones de "Guardar en Apple Wallet" van a responder
"no configurado" (error 501) hasta que agregues estos 3 archivos.

## Cuando tengas tu cuenta de Apple Developer Program ($99/año)

1. Entra a developer.apple.com → Certificates, Identifiers & Profiles.
2. En **Identifiers**, crea un **Pass Type ID** (ej. `pass.com.paeagency.vuelve`).
   Ese identificador va en tu `.env` como `APPLE_PASS_TYPE_IDENTIFIER`.
3. Dentro de ese Pass Type ID, crea un certificado. Apple te va a pedir subir
   un "Certificate Signing Request" (CSR) — lo generas así en tu computadora:
   ```
   openssl req -new -newkey rsa:2048 -nodes -keyout signerKey.pem -out request.csr
   ```
   Sube `request.csr` a Apple, descarga el certificado que te devuelven
   (viene como `.cer`), y conviértelo a `.pem`:
   ```
   openssl x509 -inform der -in el_certificado_de_apple.cer -out signerCert.pem
   ```
4. Descarga el certificado intermedio **Apple Worldwide Developer Relations
   (WWDR)** desde developer.apple.com/certificationauthority — conviértelo
   igual con `openssl x509 -inform der -in AppleWWDRCA.cer -out wwdr.pem`.
5. Copia aquí los 3 archivos: `signerCert.pem`, `signerKey.pem`, `wwdr.pem`.
6. En tu `.env`, llena `APPLE_TEAM_IDENTIFIER` (lo ves en tu cuenta de
   developer.apple.com, arriba a la derecha — es un código de 10 caracteres).

Con eso, el endpoint `/api/businesses/:slug/wallet/apple/:phone` empieza a
devolver archivos `.pkpass` reales y firmados.

Esta carpeta ya está en `.gitignore` — nunca subas estos archivos a un
repositorio público, son la identidad criptográfica de tu cuenta.

## En Railway

En lugar de subir archivos, pega el contenido completo de cada .pem en las variables APPLE_SIGNER_CERT, APPLE_SIGNER_KEY y APPLE_WWDR_CERT del servicio.
