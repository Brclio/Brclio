The CA bundle is the Mozilla trust store distributed by curl at
https://curl.se/ca/cacert.pem, retrieved on 2026-10-18. Its source metadata dates it
2026-09-25. SHA-256:
`a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505`.

`src/roots.js` is a preprocessed subtls certificate database of this exact bundle,
so Worker requests do not parse the whole PEM certificate store. Certificates and
hostnames are always verified. Subscription skip-cert-verify flags never disable
verification.

Review and update this trust store periodically from its trusted HTTPS source.
The generated file can be recreated with `node scripts/update-roots.mjs`.
