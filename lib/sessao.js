// Sessões por cookie httpOnly persistidas no Supabase.
const supabase = require('./supabase');
const auth = require('./auth');

const COOKIE = 'sessao';
const DURACAO = 60 * 60 * 24 * 7; // 7 dias

async function criar(res, usuarioId, pendente, maxAge) {
  const duracao = maxAge || DURACAO;
  const token = auth.novoTokenSessao();
  const expiraEm = new Date(Date.now() + duracao * 1000).toISOString();
  const { error } = await supabase.from('sessoes')
    .insert({ token, usuario_id: usuarioId, pendente: !!pendente, expira_em: expiraEm });
  if (error) throw error;
  res.setHeader('Set-Cookie', auth.cookieSessao(token, duracao));
  return token;
}

// devolve { usuario, pendente, token } ou null
async function obter(req) {
  const token = auth.lerCookie(req, COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const { data, error } = await supabase.from('sessoes').select(
    'token,usuario_id,pendente,expira_em,usuarios(id,email,nome,admin,plano,assinatura_status,assinatura_vence_em,twofa_ativo)'
  ).eq('token', token).maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expira_em) < new Date()) return null;
  if (!data.usuarios) return null;
  return { usuario: data.usuarios, pendente: !!data.pendente, token };
}

async function apagar(req, res) {
  const token = auth.lerCookie(req, COOKIE);
  if (/^[a-f0-9]{64}$/.test(token)) {
    await supabase.from('sessoes').delete().eq('token', token);
  }
  res.setHeader('Set-Cookie', auth.cookieApagarSessao());
}

// guarda de rotas: devolve { usuario } ou { falha: status, mensagem }
function autorizar(req, opcoes) {
  const op = opcoes || {};
  return obter(req).then((sessao) => {
    if (!sessao) return { falha: 401, mensagem: 'Faça login para continuar' };
    if (sessao.pendente && !op.pendente) return { falha: 403, mensagem: 'Conclua a verificação em duas etapas' };
    if (op.admin && !sessao.usuario.admin) return { falha: 403, mensagem: 'Acesso restrito ao administrador' };
    return { usuario: sessao.usuario };
  });
}

function negar(res, falha) {
  res.statusCode = falha.status || falha.falha || 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, erro: falha.mensagem || falha.erro || 'Não autorizado' }));
}

module.exports = { COOKIE, DURACAO, criar, obter, apagar, autorizar, negar };
