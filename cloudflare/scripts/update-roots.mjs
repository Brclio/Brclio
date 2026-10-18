import {TrustedCert} from 'subtls';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const pem=await readFile(new URL('../certs/ca-bundle.pem',import.meta.url),'utf8');
const db=await TrustedCert.databaseFromPEM(pem);
await writeFile(new URL('../src/roots.js',import.meta.url),'// Mozilla root certificates, curl.se/ca/cacert.pem; see ../certs/README.md.\nconst base64 = '+JSON.stringify(Buffer.from(db.data).toString('base64'))+';\nexport const rootCerts = {index: '+JSON.stringify(db.index)+', data: Uint8Array.from(atob(base64), c => c.charCodeAt(0))};\n');
console.log('Rebuilt trust database. Verify and record bundle SHA-256:',createHash('sha256').update(pem).digest('hex'));
