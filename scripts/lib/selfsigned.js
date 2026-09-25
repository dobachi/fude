// selfsigned.js - Generate and reuse a self-signed certificate for remote mode.
//
// When browser mode is opened to a network range, the access key and every byte
// of the documents travel over that network. Plain HTTP would hand both to
// anyone who can capture the traffic, so remote mode speaks TLS.
//
// The certificate is self-signed, which means the phone will warn once. The
// SHA-256 fingerprint is printed at startup so that warning can be checked
// against something rather than clicked through blindly.
//
// OpenSSL does the X.509 work: Node can generate keys but cannot self-sign, and
// a pure-JS certificate library would be the first runtime dependency in a
// project that deliberately has none.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const netaccess = require('./netaccess');

const DAYS = 825; // the longest lifetime browsers still accept for a leaf cert
const RENEW_WITHIN_DAYS = 30;

function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every address a client might type, so the certificate matches whichever one
 * they use. A mismatch produces a second, different browser warning.
 */
function localAddresses() {
  const addrs = new Set(['127.0.0.1', '::1']);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list || []) {
      if (iface.address) addrs.add(iface.address.replace(/%.*$/, ''));
    }
  }
  return [...addrs];
}

function buildSan(hosts) {
  const ips = [];
  const dns = new Set(['localhost']);
  for (const h of hosts) {
    if (/^[\d.]+$/.test(h) || h.includes(':')) ips.push(h);
    else dns.add(h);
  }
  return [...ips.map((ip) => `IP:${ip}`), ...[...dns].map((d) => `DNS:${d}`)].join(',');
}

function readSan(certPath) {
  try {
    const out = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-ext', 'subjectAltName'], {
      encoding: 'utf-8',
    });
    return out;
  } catch {
    return '';
  }
}

function expiringSoon(certPath) {
  try {
    execFileSync(
      'openssl',
      ['x509', '-in', certPath, '-noout', '-checkend', String(RENEW_WITHIN_DAYS * 86400)],
      { stdio: 'ignore' },
    );
    return false;
  } catch {
    return true; // non-zero exit means it expires within the window
  }
}

function fingerprint(certPath) {
  try {
    const out = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], {
      encoding: 'utf-8',
    });
    const m = out.match(/=([0-9A-Fa-f:]+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * Does the existing cert already cover every address we are about to serve on?
 *
 * OpenSSL prints IPv6 SANs in its own expanded, upper-case form
 * (`::1` comes back as `IP Address:0:0:0:0:0:0:0:1`), so the addresses are
 * compared numerically. Matching on the printed text regenerated the
 * certificate on every single start.
 */
function covers(certPath, hosts) {
  const san = readSan(certPath);
  if (!san) return false;

  const certIps = [];
  const certDns = new Set();
  for (const m of san.matchAll(/IP Address:([0-9A-Fa-f.:]+)/g)) {
    const n = netaccess.ipToBigInt(netaccess.normalizeIp(m[1]) || '');
    if (n !== null) certIps.push(n);
  }
  for (const m of san.matchAll(/DNS:([^,\s]+)/g)) {
    certDns.add(m[1].toLowerCase());
  }

  return hosts.every((h) => {
    const normalized = netaccess.normalizeIp(h);
    if (normalized) {
      const n = netaccess.ipToBigInt(normalized);
      return n !== null && certIps.some((c) => c === n);
    }
    return certDns.has(String(h).toLowerCase());
  });
}

function generate(certPath, keyPath, hosts) {
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      String(DAYS),
      '-subj',
      '/CN=Fude browser mode',
      '-addext',
      `subjectAltName=${buildSan(hosts)}`,
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext',
      'extendedKeyUsage=serverAuth',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
}

/**
 * Return usable cert/key material, generating it if needed.
 *
 * @returns {{cert: Buffer, key: Buffer, fingerprint: string, generated: boolean, certPath: string}}
 */
function ensureCert({ configDir, hosts = localAddresses() } = {}) {
  const certPath = path.join(configDir, 'cert.pem');
  const keyPath = path.join(configDir, 'cert-key.pem');

  const haveBoth = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const needsNew = !haveBoth || expiringSoon(certPath) || !covers(certPath, hosts);

  if (needsNew) {
    if (!opensslAvailable()) {
      throw new Error(
        'openssl is required to generate the TLS certificate for remote mode.\n' +
          'Install it, or supply your own with --tls-cert/--tls-key,\n' +
          'or use --no-tls behind an SSH tunnel or Tailscale.',
      );
    }
    generate(certPath, keyPath, hosts);
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    fingerprint: fingerprint(certPath),
    generated: needsNew,
    certPath,
  };
}

module.exports = { ensureCert, localAddresses, buildSan, opensslAvailable, fingerprint, covers };
