// Autenticação da parte 2: senhas (scrypt), sessões por cookie e 2FA TOTP.
// Tudo com módulos nativos — sem dependências extras.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verificarSenha(senha, armazenado) {
  try {
    const [saltHex, hashHex] = String(armazenado).split(':');
    const hash = crypto.scryptSync(String(senha), Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch (e) {
    return false;
  }
}

// TOTP (RFC 6238) com Base32 (RFC 4648, sem padding)
function gerarSecret() {
  // Base32 canônico (RFC 4648): 20 bytes = 32 caracteres [A-Z2-7] — o formato
  // que o Google Authenticator aceita.
  const bytes = crypto.randomBytes(20);
  let saida = '';
  let bits = 0, valor = 0;
  for (const b of bytes) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      saida += B32[(valor >> bits) & 31];
    }
  }
  if (bits > 0) saida += B32[(valor << (5 - bits)) & 31];
  return saida;
}

function base32Decode(s) {
  let bits = 0, valor = 0, saida = [];
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    valor = (valor << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      saida.push((valor >> bits) & 0xff);
    }
  }
  return Buffer.from(saida);
}

function codigoTotp(secret, tempoSegundos) {
  const chave = base32Decode(secret);
  const contador = Buffer.alloc(8);
  const agora = Number.isFinite(tempoSegundos) ? tempoSegundos : Date.now() / 1000;
  contador.writeBigUInt64BE(BigInt(Math.floor(agora / 30)));
  const hmac = crypto.createHmac('sha1', chave).update(contador).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// aceita o código do período atual ou do anterior (tolerância de relógio)
function verificar2fa(secret, codigo, tempoSegundos) {
  if (!secret || !/^\d{6}$/.test(String(codigo || ''))) return false;
  const agora = Math.floor(tempoSegundos || Date.now() / 1000);
  return [0, -30].some((desloc) => codigoTotp(secret, agora + desloc) === String(codigo));
}

// segundos restantes do período atual (para a barrinha de tempo)
function segundosRestantes(agoraSegundos) {
  return 30 - (Math.floor(agoraSegundos || Date.now() / 1000) % 30);
}

function uriOtpauth(secret, email) {
  return 'otpauth://totp/PlayGenerator:' + encodeURIComponent(email) +
    '?secret=' + secret + '&issuer=PlayGenerator&algorithm=SHA1&digits=6&period=30';
}

// sessões
function novoTokenSessao() {
  return crypto.randomBytes(32).toString('hex');
}

function cookieSessao(token, maxAgeSegundos) {
  return 'sessao=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSegundos;
}

function cookieApagarSessao() {
  return 'sessao=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function lerCookie(req, nome) {
  const bruto = (req.headers && req.headers.cookie) || '';
  for (const parte of bruto.split(';')) {
    const [k, ...resto] = parte.trim().split('=');
    if (k === nome) return resto.join('=');
  }
  return '';
}

module.exports = {
  hashSenha, verificarSenha,
  gerarSecret, base32Decode, codigoTotp, verificar2fa, segundosRestantes, uriOtpauth,
  novoTokenSessao, cookieSessao, cookieApagarSessao, lerCookie
};
