require('dotenv').config();
const express = require('express');
const path = require('path');
const handlers = require('./lib/handlers');
const contas = require('./lib/contas');
const admin = require('./lib/admin');

const app = express();
app.use((req, res, next) => { console.error('REQ:', req.method, req.url); next(); });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload-url', handlers.uploadUrl);
app.post('/api/gerar', handlers.gerar);
app.get('/api/campanhas', handlers.campanhas);
app.get('/api/health', handlers.health);
app.get('/api/download', handlers.download);
app.get('/:token', handlers.pagina);

// parte 2: contas, 2FA e painel administrativo (rotas de 1 nível — plano Hobby)
app.all('/api/auth', contas.authApi);
app.all('/api/meus-apps', contas.meusApps);
app.all('/api/admin', admin.adminApi);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Backend rodando em http://localhost:' + PORT));
