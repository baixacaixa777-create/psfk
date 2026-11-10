require('dotenv').config();
const express = require('express');
const path = require('path');
const handlers = require('./lib/handlers');
const contas = require('./lib/contas');
const admin = require('./lib/admin');

// wrapper para rotas com métodos mistos (na Vercel um arquivo atende todos)
const porMetodo = (mapa) => (req, res) => (mapa[req.method] || ((r, s) => { s.statusCode = 405; s.end(); }))(req, res);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload-url', handlers.uploadUrl);
app.post('/api/gerar', handlers.gerar);
app.get('/api/campanhas', handlers.campanhas);
app.get('/api/health', handlers.health);
app.get('/api/download', handlers.download);
app.get('/:token', handlers.pagina);

// parte 2: contas, 2FA e painel administrativo
app.post('/api/auth/registrar', contas.registrar);
app.post('/api/auth/login', contas.login);
app.post('/api/auth/2fa/verificar', contas.verificar);
app.post('/api/auth/logout', contas.logout);
app.get('/api/auth/eu', contas.eu);
app.get('/api/meus-apps', contas.meusApps);
app.all('/api/admin/overview', porMetodo({ GET: admin.overview }));
app.all('/api/admin/apps', porMetodo({ GET: admin.apps, PATCH: admin.appsEditar, DELETE: admin.appsEditar }));
app.all('/api/admin/usuarios', porMetodo({ GET: admin.usuarios, PATCH: admin.usuariosEditar, DELETE: admin.usuariosEditar }));
app.all('/api/admin/acessos', porMetodo({ GET: admin.acessos }));
app.all('/api/admin/2fa', porMetodo({ GET: admin.codigo2fa, POST: admin.resetar2fa }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Backend rodando em http://localhost:' + PORT));
