// Catch-all: consolida todas as rotas administrativas e de contas em UMA função
// serverless — o plano Hobby da Vercel limita a 12 funções por deploy.
const contas = require('../lib/contas');
const admin = require('../lib/admin');
const handlers = require('../lib/handlers');

const rotas = {
  'GET /api/health': handlers.health,
  'GET /api/campanhas': handlers.campanhas,
  'GET /api/auth/eu': contas.eu,
  'GET /api/meus-apps': contas.meusApps,
  'POST /api/auth/registrar': contas.registrar,
  'POST /api/auth/login': contas.login,
  'POST /api/auth/2fa/verificar': contas.verificar,
  'POST /api/auth/logout': contas.logout,
  'GET /api/admin/overview': admin.overview,
  'GET /api/admin/apps': admin.apps,
  'PATCH /api/admin/apps': admin.appsEditar,
  'DELETE /api/admin/apps': admin.appsEditar,
  'GET /api/admin/usuarios': admin.usuarios,
  'PATCH /api/admin/usuarios': admin.usuariosEditar,
  'DELETE /api/admin/usuarios': admin.usuariosEditar,
  'GET /api/admin/2fa': admin.codigo2fa,
  'POST /api/admin/2fa': admin.resetar2fa,
  'GET /api/admin/acessos': admin.acessos
};

export default function (req, res) {
  const caminho = new URL(req.url || '/', 'http://interno').pathname;
  const funcao = rotas[req.method + ' ' + caminho];
  if (!funcao) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: false, erro: 'Rota não encontrada' }));
  }
  return funcao(req, res);
}
