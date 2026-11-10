// Parte 2: painel administrativo — storage, apps, usuários, assinaturas e 2FA ao vivo.
const supabase = require('./supabase');
const auth = require('./auth');
const sessao = require('./sessao');
const contas = require('./contas');

const json = contas.json;
const LIMITE_STORAGE_BYTES = 1024 * 1024 * 1024; // 1 GB do plano gratuito

async function tamanhoBucket(bucket) {
  let total = 0;
  let offset = 0;
  for (let pagina = 0; pagina < 50; pagina++) {
    const { data, error } = await supabase.storage.from(bucket).list('', { limit: 1000, offset });
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const o of data) total += (o.metadata && o.metadata.size) || 0;
    if (data.length < 1000) break;
    offset += data.length;
  }
  return total;
}

async function guardar(req, res) {
  // devolve o guard inteiro: { usuario } ou { falha } — o handler responde
  return sessao.autorizar(req, { admin: true });
}

// GET /api/admin/overview — % de storage, contagens e resumo
async function overview(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    const usuario = await guardar(req, res);
    if (usuario.falha) return sessao.negar(res, usuario);
    const [pages, midia, usuarios, apps] = await Promise.all([
      tamanhoBucket('pages'), tamanhoBucket('midia'),
      supabase.from('usuarios').select('id', { count: 'exact', head: true }),
      supabase.from('campanhas').select('token', { count: 'exact', head: true })
    ]);
    const usado = pages + midia;
    json(res, 200, {
      ok: true,
      storage: { usado_bytes: usado, limite_bytes: LIMITE_STORAGE_BYTES, percentual: +(usado / LIMITE_STORAGE_BYTES * 100).toFixed(2), pages_bytes: pages, midia_bytes: midia },
      total_usuarios: usuarios.count ?? null,
      total_apps: apps.count ?? null
    });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// GET /api/admin/apps — lista completa de apps com dono e prazo
async function apps(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    const usuario = await guardar(req, res);
    if (usuario.falha) return sessao.negar(res, usuario);
    const { data, error } = await supabase.from('campanhas')
      .select('token,titulo,criado_em,expira_em,usuarios(email,nome)')
      .order('criado_em', { ascending: false });
    if (error) return json(res, 500, { ok: false, erro: error.message });
    const agora = Date.now();
    const lista = (data || []).map(a => ({
      token: a.token, titulo: a.titulo, criado_em: a.criado_em, expira_em: a.expira_em,
      dono: a.usuarios ? a.usuarios.email : null,
      dias_restantes: a.expira_em ? Math.ceil((new Date(a.expira_em) - agora) / 864e5) : null,
      expirado: a.expira_em ? new Date(a.expira_em) < agora : false
    }));
    json(res, 200, { ok: true, apps: lista });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// PATCH /api/admin/apps?token=X — altera o prazo de expiração (dias ou data)
// DELETE /api/admin/apps?token=X — apaga a página do Storage e o registro
async function appsEditar(req, res, opcoes) {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    const usuario = await guardar(req, res);
    if (usuario.falha) return sessao.negar(res, usuario);
    const b = await contas.lerJson(req);
    const token = String(b.token || '');
    if (!/^[a-f0-9]{48}$/.test(token)) return json(res, 400, { ok: false, erro: 'Token inválido' });
    if (!(b.apagar || (opcoes && opcoes.apagar))) {
      let expiraEm;
      if (b.dias !== undefined) expiraEm = new Date(Date.now() + Number(b.dias) * 864e5).toISOString();
      else if (b.expira_em) expiraEm = new Date(b.expira_em).toISOString();
      if (!expiraEm || isNaN(new Date(expiraEm))) return json(res, 400, { ok: false, erro: 'Informe dias ou expira_em' });
      const { error } = await supabase.from('campanhas').update({ expira_em: expiraEm }).eq('token', token);
      if (error) return json(res, 500, { ok: false, erro: error.message });
      return json(res, 200, { ok: true, expira_em: expiraEm });
    }
    // apagar: remove do Storage e do banco
    const { data: pub } = supabase.storage.from('pages').getPublicUrl(token + '.html');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const r = await fetch(pub.publicUrl, { redirect: 'error', signal: controller.signal });
    clearTimeout(timeout);
    if (r.ok) {
      const { error: eDel } = await supabase.storage.from('pages').remove([token + '.html']);
      if (eDel) return json(res, 500, { ok: false, erro: eDel.message });
    }
    if (r.body) await r.body.cancel();
    const { error } = await supabase.from('campanhas').delete().eq('token', token);
    if (error) return json(res, 500, { ok: false, erro: error.message });
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// GET /api/admin/acessos?token=X — acessos recentes da página (últimos 50 + total 7 dias)
async function acessos(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    const guard = await sessao.autorizar(req, { admin: true });
    if (guard.falha) return sessao.negar(res, guard);
    const b = await contas.lerJson(req);
    const token = String(b.token || '');
    if (!/^[a-f0-9]{48}$/.test(token)) return json(res, 400, { ok: false, erro: 'Token inválido' });
    const { data, error } = await supabase.from('acessos')
      .select('criado_em,user_agent').eq('token', token).order('criado_em', { ascending: false });
    if (error) return json(res, 500, { ok: false, erro: error.message });
    const limite7d = Date.now() - 7 * 864e5;
    const lista = data || [];
    json(res, 200, {
      ok: true,
      total_7d: lista.filter(a => new Date(a.criado_em) >= limite7d).length,
      total: lista.length,
      ultimos: lista.slice(0, 50)
    });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// GET /api/admin/usuarios — lista com assinatura e 2FA
async function usuarios(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    const usuario = await guardar(req, res);
    if (usuario.falha) return sessao.negar(res, usuario);
    const { data, error } = await supabase.from('usuarios')
      .select('id,email,nome,admin,plano,assinatura_status,assinatura_vence_em,twofa_ativo,criado_em')
      .order('criado_em', { ascending: false });
    if (error) return json(res, 500, { ok: false, erro: error.message });
    json(res, 200, { ok: true, usuarios: data || [] });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// PATCH /api/admin/usuarios?id=X — plano, status da assinatura, vencimento, excluir
async function usuariosEditar(req, res, opcoes) {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    const admin = await guardar(req, res);
    if (admin.falha) return sessao.negar(res, admin);
    const b = await contas.lerJson(req);
    const id = String(b.id || '');
    if (!/^[a-f0-9-]{36}$/i.test(id)) return json(res, 400, { ok: false, erro: 'ID inválido' });
    if (b.excluir === true || (opcoes && opcoes.excluir) || req.method === 'DELETE') {
      if (id === admin.id) return json(res, 400, { ok: false, erro: 'Não é possível excluir a si mesmo' });
      const { error } = await supabase.from('usuarios').delete().eq('id', id);
      if (error) return json(res, 500, { ok: false, erro: error.message });
      return json(res, 200, { ok: true });
    }
    const mudancas = {};
    if (b.plano !== undefined) {
      if (!contas.DIAS_PLANO[b.plano]) return json(res, 400, { ok: false, erro: 'Plano inválido' });
      mudancas.plano = b.plano;
    }
    if (b.assinatura_status !== undefined) {
      if (!['pendente', 'ativa', 'cancelada'].includes(b.assinatura_status)) return json(res, 400, { ok: false, erro: 'Status inválido' });
      mudancas.assinatura_status = b.assinatura_status;
    }
    if (b.vencer_dias !== undefined) {
      mudancas.assinatura_vence_em = new Date(Date.now() + Number(b.vencer_dias) * 864e5).toISOString();
    }
    if (b.redefinir_senha !== undefined) {
      if (String(b.redefinir_senha).length < 8) return json(res, 400, { ok: false, erro: 'Senha muito curta' });
      mudancas.senha_hash = auth.hashSenha(String(b.redefinir_senha));
    }
    if (!Object.keys(mudancas).length) return json(res, 400, { ok: false, erro: 'Nada para alterar' });
    const { error } = await supabase.from('usuarios').update(mudancas).eq('id', id);
    if (error) return json(res, 500, { ok: false, erro: error.message });
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// GET /api/admin/2fa?id=X — código TOTP atual do cliente, em tempo real
async function codigo2fa(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    const admin = await guardar(req, res);
    if (admin.falha) return sessao.negar(res, admin);
    const corpo = await contas.lerJson(req);
    const id = String(corpo.id || '');
    if (!/^[a-f0-9-]{36}$/i.test(id)) return json(res, 400, { ok: false, erro: 'ID inválido' });
    const { data: usuario, error } = await supabase.from('usuarios')
      .select('email,twofa_secret,twofa_ativo').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { ok: false, erro: error.message });
    if (!usuario || !usuario.twofa_secret) return json(res, 404, { ok: false, erro: '2FA não configurado' });
    const agora = Math.floor(Date.now() / 1000);
    json(res, 200, {
      ok: true,
      email: usuario.email,
      codigo: auth.codigoTotp(usuario.twofa_secret, agora),
      anterior: auth.codigoTotp(usuario.twofa_secret, agora - 30),
      segundos_restantes: auth.segundosRestantes(agora),
      ativo: usuario.twofa_ativo
    });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// POST /api/admin/2fa?id=X — reseta o 2FA do cliente (precisa reconfigurar)
async function resetar2fa(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    const admin = await guardar(req, res);
    if (admin.falha) return sessao.negar(res, admin);
    const corpo = await contas.lerJson(req);
    const id = String(corpo.id || '');
    if (!/^[a-f0-9-]{36}$/i.test(id)) return json(res, 400, { ok: false, erro: 'ID inválido' });
    const secret = auth.gerarSecret();
    const { data: usuario, error: e1 } = await supabase.from('usuarios')
      .select('email').eq('id', id).maybeSingle();
    if (e1 || !usuario) return json(res, 404, { ok: false, erro: 'Usuário não encontrado' });
    const { error } = await supabase.from('usuarios')
      .update({ twofa_secret: secret, twofa_ativo: false }).eq('id', id);
    if (error) return json(res, 500, { ok: false, erro: error.message });
    json(res, 200, { ok: true, twofa: { secret, uri: auth.uriOtpauth(secret, usuario.email) } });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// POST /api/admin — rota única de 1 nível; despacha por "acao"
async function adminApi(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const b = await contas.lerJson(req);
  // ações de leitura são servidas via POST; normaliza o método para os handlers
  if (['overview', 'apps', 'usuarios', '2fa', 'acessos'].includes(b.acao)) req.method = 'GET';
  switch (b.acao) {
    case 'overview': return overview(req, res);
    case 'apps': return apps(req, res);
    case 'apps-editar': return appsEditar(req, res);
    case 'apagar-app': return appsEditar(req, res, { apagar: true });
    case 'usuarios': return usuarios(req, res);
    case 'usuarios-editar': return usuariosEditar(req, res);
    case '2fa': return codigo2fa(req, res);
    case 'resetar-2fa': return resetar2fa(req, res);
    case 'acessos': return acessos(req, res);
    default: return json(res, 400, { ok: false, erro: 'Ação inválida' });
  }
}

module.exports = { overview, apps, appsEditar, usuarios, usuariosEditar, codigo2fa, resetar2fa, acessos, adminApi };
