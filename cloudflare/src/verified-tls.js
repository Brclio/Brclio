import {Cert, startTls} from 'subtls/index.js';

// subtls 0.5.0 skips unrecognized certificate extensions. Reject unsupported
// constraints before any parsed peer/signing certificate can authorize a tunnel.
// This guard only narrows trust; upstream still verifies signatures, trust,
// validity, hostnames, CA flags, path length and the TLS transcript.
const keyUsageNames = ['digitalSignature','nonRepudiation','keyEncipherment','dataEncipherment','keyAgreement','keyCertSign','cRLSign','encipherOnly','decipherOnly'];
const supportedCritical = new Set(['551d0f', '551d13', '551d11', '551d25', '551d23', '551d0e']);
function item(bytes, offset, bound) {
  if (offset + 2 > bound) throw new Error('Invalid certificate DER');
  const tag = bytes[offset++];
  let length = bytes[offset++];
  if (length & 128) {
    const count = length & 127;
    if (!count || count > 3 || offset + count > bound || bytes[offset] === 0) throw new Error('Invalid certificate DER length');
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + bytes[offset++];
    if (length < 128) throw new Error('Noncanonical certificate DER length');
  }
  const end = offset + length;
  if (end > bound) throw new Error('Invalid certificate DER bounds');
  return {tag, start: offset, end};
}
function children(bytes, parent) {
  const result = [];
  for (let offset = parent.start; offset < parent.end;) {
    if (result.length >= 128) throw new Error('Too many certificate fields');
    const field = item(bytes, offset, parent.end);
    result.push(field); offset = field.end;
  }
  return result;
}
export function validateCertificateExtensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024) throw new Error('Invalid certificate bytes');
  const certificate = item(bytes, 0, bytes.length);
  if (certificate.tag !== 48 || certificate.end !== bytes.length) throw new Error('Invalid certificate sequence');
  const tbs = children(bytes, certificate)[0];
  if (!tbs || tbs.tag !== 48) throw new Error('Invalid certificate fields');
  const wrappers = children(bytes, tbs).filter(field => field.tag === 163);
  if (wrappers.length > 1) throw new Error('Duplicate certificate extensions');
  const policy = {};
  if (!wrappers.length) return policy;
  const sequences = children(bytes, wrappers[0]);
  if (sequences.length !== 1 || sequences[0].tag !== 48) throw new Error('Invalid certificate extensions');
  const seen = new Set();
  for (const extension of children(bytes, sequences[0])) {
    if (extension.tag !== 48) throw new Error('Invalid certificate extension');
    const fields = children(bytes, extension);
    if (fields.length < 2 || fields.length > 3 || fields[0].tag !== 6) throw new Error('Invalid certificate extension fields');
    const oid = Array.from(bytes.subarray(fields[0].start, fields[0].end), byte => byte.toString(16).padStart(2, '0')).join('');
    if (!oid || seen.has(oid)) throw new Error('Duplicate certificate extension');
    let arcStart = true;
    for (const byte of bytes.subarray(fields[0].start, fields[0].end)) {
      if (arcStart && byte === 128) throw new Error('Invalid certificate extension OID');
      arcStart = (byte & 128) === 0;
    }
    if (!arcStart) throw new Error('Invalid certificate extension OID');
    seen.add(oid);
    let critical = false;
    if (fields[1].tag === 1) {
      if (fields.length !== 3 || fields[1].end - fields[1].start !== 1 || ![0, 255].includes(bytes[fields[1].start])) throw new Error('Invalid extension critical flag');
      critical = bytes[fields[1].start] === 255;
    } else if (fields.length !== 2) throw new Error('Invalid extension critical flag');
    if (fields.at(-1).tag !== 4) throw new Error('Invalid certificate extension value');
    if (oid === '551d0f') {
      const value = fields.at(-1), bits = item(bytes, value.start, value.end);
      if (bits.tag !== 3 || bits.end !== value.end || bits.end - bits.start < 2 || bits.end - bits.start > 3) throw new Error('Invalid certificate key usage');
      const padding = bytes[bits.start], octets = bytes.subarray(bits.start + 1, bits.end);
      if (padding > 7 || (octets.at(-1) & ((1 << padding) - 1)) || (octets.length === 2 && (octets[1] & 127))) throw new Error('Invalid certificate key usage');
      const usages = new Set(keyUsageNames.filter((_, index) => index < octets.length * 8 - padding && (octets[index >> 3] & (128 >> (index & 7)))));
      if (!usages.size) throw new Error('Invalid certificate key usage');
      policy.keyUsage = {critical, usages};
    }
    if (oid === '551d1e') throw new Error('Unsupported certificate name constraints');
    if (critical && !supportedCritical.has(oid)) throw new Error('Unsupported critical certificate extension');
  }
  return policy;
}

// Cert.create is a public upstream API used for every received certificate and
// every selected trust anchor, including TrustedCert's inherited implementation.
// Preserve its receiver so anchors retain their TrustedCert identity.
const createCertificate = Cert.create;
Cert.create = async function (...args) {
  const certificate = await Reflect.apply(createCertificate, this, args);
  const policy = validateCertificateExtensions(certificate.rawData);
  // X.509 KeyUsage bits are indexed from the most significant bit, regardless
  // of DER padding. Upstream's right-aligned integer mapping loses that order.
  if (policy.keyUsage) certificate.keyUsage = policy.keyUsage;
  if (certificate.basicConstraints?.ca) {
    if (certificate.keyUsage && !certificate.keyUsage.usages.has('keyCertSign')) throw new Error('CA certificate cannot sign certificates');
    if (certificate.extKeyUsage && certificate.extKeyUsage.serverTls !== true) throw new Error('CA certificate does not permit TLS server authentication');
  } else if (certificate.keyUsage && !certificate.keyUsage.usages.has('digitalSignature')) {
    throw new Error('Server certificate cannot make digital signatures');
  }
  return certificate;
};
export function startVerifiedTls(host, roots, read, write, options = {}) {
  // Upstream's requireDigitalSigKeyUsage flag incorrectly requires the CA's
  // digitalSignature bit. X.509 instead uses keyCertSign for CA signatures.
  // The guard above enforces keyCertSign on CAs and digitalSignature on leaves.
  return startTls(host, roots, read, write, {...options, requireServerTlsExtKeyUsage: true, requireDigitalSigKeyUsage: false});
}
