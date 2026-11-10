// Parte 2: contas de clientes — cadastro com 2FA obrigatório, login, sessões.
const crypto = require('crypto');
const supabase = require('./supabase');
const auth = require('./auth');
const sessao = require('./sessao');

function json(res, status, obj, cabecalhos) {
  res.statusCode = status;
  if (cabecalhos) for (const [k, v] of Object.entries(cabecalhos)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function lerJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function emailsAdmin() {
  return String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLANOS = ['quinzenal', 'mensal', 'trimestral'];
const DIAS_PLANO = { quinzenal: 15, mensal: 30, trimestral: 90 };
// protege o Storage do plano gratuito do Supabase
const LIMITES_APPS = { quinzenal: 5, mensal: 20, trimestral: Infinity };

// POST /api/auth/registrar — cria a conta e inicia o cadastro do 2FA
async function registrar(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const b = await lerJson(req);
  const email = String(b.email || '').trim().toLowerCase();
  const nome = String(b.nome || '').trim().slice(0, 80);
  const senha = String(b.senha || '');
  if (!EMAIL_RE.test(email)) return json(res, 400, { ok: false, erro: 'E-mail inválido' });
  if (senha.length < 8) return json(res, 400, { ok: false, erro: 'A senha precisa ter pelo menos 8 caracteres' });
  const admin = emailsAdmin().includes(email);
  try {
    const secret = auth.gerarSecret();
    const { data, error } = await supabase.from('usuarios').insert({
      email, nome, senha_hash: auth.hashSenha(senha), admin,
      plano: PLANOS.includes(b.plano) ? b.plano : 'mensal',
      assinatura_status: admin ? 'ativa' : 'pendente',
      assinatura_vence_em: admin ? new Date(Date.now() + 365 * 864e5).toISOString() : null,
      twofa_secret: secret,
      twofa_ativo: false
    }).select('id,email,nome,admin').single();
    if (error) {
      const msg = /duplicate|unique/i.test(error.message) ? 'Este e-mail já está registrado' : error.message;
      return json(res, 400, { ok: false, erro: msg });
    }
    await sessao.criar(res, data.id, true); // sessão pendente até confirmar o 2FA
    return json(res, 200, {
      ok: true, admin: data.admin,
      twofa: { secret, uri: auth.uriOtpauth(secret, email) }
    });
  } catch (e) {
    return json(res, 500, { ok: false, erro: e.message });
  }
}

// POST /api/auth/login — senha; retorna pendência de 2FA quando ativo
async function login(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const b = await lerJson(req);
  const email = String(b.email || '').trim().toLowerCase();
  const senha = String(b.senha || '');
  try {
    const { data: usuario, error } = await supabase.from('usuarios')
      .select('id,email,nome,admin,senha_hash,twofa_ativo')
      .eq('email', email).maybeSingle();
    if (error || !usuario || !auth.verificarSenha(senha, usuario.senha_hash)) {
      return json(res, 401, { ok: false, erro: 'E-mail ou senha incorretos' });
    }
    if (!usuario.twofa_ativo) {
      // conta criada antes de concluir o 2FA: retoma o cadastro
      const secret = usuario.twofa_secret || auth.gerarSecret();
      if (!usuario.twofa_secret) {
        await supabase.from('usuarios').update({ twofa_secret: secret }).eq('id', usuario.id);
      }
      await sessao.criar(res, usuario.id, true);
      return json(res, 200, { ok: true, pendente_2fa: true, twofa: { secret, uri: auth.uriOtpauth(secret, email) } });
    }
    await sessao.criar(res, usuario.id, true); // pendente até validar o código
    return json(res, 200, { ok: true, pendente_2fa: true });
  } catch (e) {
    return json(res, 500, { ok: false, erro: e.message });
  }
}

// POST /api/auth/2fa/verificar — login: valida o código e libera a sessão
async function verificar(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const b = await lerJson(req);
  const s = await sessao.obter(req);
  if (!s) return json(res, 401, { ok: false, erro: 'Faça login para continuar' });
  try {
    const { data: usuario, error } = await supabase.from('usuarios')
      .select('id,twofa_secret,twofa_ativo').eq('id', s.usuario.id).maybeSingle();
    if (error || !usuario) return json(res, 401, { ok: false, erro: 'Sessão inválida' });
    if (!usuario.twofa_secret || !auth.verificar2fa(usuario.twofa_secret, b.codigo)) {
      return json(res, 401, { ok: false, erro: 'Código incorreto' });
    }
    if (!usuario.twofa_ativo) {
      const { error: e2 } = await supabase.from('usuarios').update({ twofa_ativo: true }).eq('id', usuario.id);
      if (e2) return json(res, 500, { ok: false, erro: e2.message });
    }
    await sessao.criar(res, usuario.id, false);
    await supabase.from('sessoes').delete().eq('token', s.token);
    return json(res, 200, { ok: true, usuario: { email: s.usuario.email, nome: s.usuario.nome, admin: s.usuario.admin } });
  } catch (e) {
    return json(res, 500, { ok: false, erro: e.message });
  }
}

// POST /api/auth/logout
async function logout(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  await sessao.apagar(req, res);
  return json(res, 200, { ok: true });
}

// GET /api/auth/eu — dados da sessão atual
async function eu(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const s = await sessao.obter(req);
  if (!s) return json(res, 401, { ok: false, erro: 'Sem sessão' });
  const u = s.usuario;
  return json(res, 200, {
    ok: true, pendente_2fa: s.pendente,
    usuario: { email: u.email, nome: u.nome, admin: u.admin, plano: u.plano,
      assinatura_status: u.assinatura_status, assinatura_vence_em: u.assinatura_vence_em }
  });
}

// GET /api/meus-apps — lista dos apps do cliente logado
async function meusApps(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const guard = await sessao.autorizar(req);
  if (guard.falha) return sessao.negar(res, guard);
  try {
    const { data, error } = await supabase.from('campanhas')
      .select('token,titulo,criado_em,expira_em')
      .eq('usuario_id', guard.usuario.id)
      .order('criado_em', { ascending: false });
    if (error) return json(res, 500, { ok: false, erro: error.message });
    const agora = Date.now();
    const apps = (data || []).map(a => ({
      token: a.token,
      titulo: a.titulo,
      criado_em: a.criado_em,
      expira_em: a.expira_em,
      dias_restantes: a.expira_em ? Math.max(0, Math.ceil((new Date(a.expira_em) - agora) / 864e5)) : null,
      expirado: a.expira_em ? new Date(a.expira_em) < agora : false
    }));
    const limite = LIMITES_APPS[guard.usuario.plano];
    json(res, 200, {
      ok: true, apps,
      plano: guard.usuario.plano,
      limite_apps: limite === Infinity ? null : limite,
      apps_usados: apps.filter(a => !a.expirado).length
    });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// associado no gerar: gera expiração padrão (30 dias)
function expiracaoPadrao(dias) {
  const d = Number(dias) > 0 ? Number(dias) : 30;
  return new Date(Date.now() + d * 864e5).toISOString();
}

// POST /api/auth — rota única de 1 nível; despacha por "acao" (GET = sessão atual)
async function authApi(req, res) {
  if (req.method === 'GET') return eu(req, res);
  const b = await lerJson(req);
  switch (b.acao) {
    case 'registrar': return registrar(req, res);
    case 'login': return login(req, res);
    case 'verificar': return verificar(req, res);
    case 'logout': return logout(req, res);
    default: return json(res, 400, { ok: false, erro: 'Ação inválida' });
  }
}

module.exports = {
  registrar, login, verificar, logout, eu, meusApps, authApi,
  emailsAdmin, expiracaoPadrao, DIAS_PLANO, LIMITES_APPS, lerJson, json
};
