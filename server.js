require('dotenv').config();
const express = require('express');
const path = require('path');
const handlers = require('./lib/handlers');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload-url', handlers.uploadUrl);
app.post('/api/gerar', handlers.gerar);
app.get('/api/campanhas', handlers.campanhas);
app.get('/:token', handlers.pagina);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Backend rodando em http://localhost:' + PORT));
