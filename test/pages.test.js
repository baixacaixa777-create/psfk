const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const express = require('express');
const auth = require('../lib/auth');

// Nenhuma credencial ou conexão de produção: todos os acessos Supabase são mocks.
const TOKEN = 'a'.repeat(48);
const STORAGE = 'https://storage.invalid/storage/v1/object/public/';
const chamadas = [];
let storageStatus = 200;
let storageFalha = false;
let dbFalha = false;
let enviado = null;
const { criarMockSupabase } = require('./mock-supabase');
const db = { usuarios: [], sessoes: [], campanhas: [] };
const baseMock = criarMockSupabase(db);
let linha = null;
const mockSupabase = {
  storage: {
    from(bucket) {
      const real = baseMock.storage.from(bucket);
      return Object.assign({}, real, {
        async upload(arquivo, buffer, options) {
          chamadas.push(['upload', bucket, arquivo]);
          if (bucket === 'pages') enviado = buffer.toString('utf8');
          return real.upload(arquivo, buffer, options);
        },
        async remove(arquivos) {
          chamadas.push(['remove', bucket, arquivos]);
          return real.remove(arquivos);
        },
        async createSignedUploadUrl(arquivo) {
          chamadas.push(['signedUpload', bucket, arquivo]);
          return real.createSignedUploadUrl(arquivo);
        }
      });
    }
  },
  from(tabela) {
    const real = baseMock.from(tabela);
    return Object.assign({}, real, {
      insert(l) {
        if (tabela === 'campanhas') linha = l;
        if (dbFalha) return { select() { return { single: async () => ({ data: null, error: new Error('DB mock indisponível') }) } }, error: new Error('DB mock indisponível') };
        return real.insert(l);
      }
    });
  }
};
const supabasePath = require.resolve('../lib/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: mockSupabase };
const { gerarHtml } = require('../lib/gerarHtml');
const html = gerarHtml({
  titulo: 'Teste visual & renderização', empresa: 'Empresa de teste', dev_id: '123', nota: '4,8',
  num_avaliacoes: '100 avaliações', classificacao: 'Livre', downloads: '10 mil+',
  descricao: 'Linha 1\nLinha 2 <segura>' + 'x'.repeat(100000), descricao_curta: 'Resumo',
  atualizado_em: '10 de novembro', disponivel_em: 'Android',
  icone_url: 'https://images.invalid/icon.png', screenshots: ['https://images.invalid/screen.png']
});
assert.ok(Buffer.byteLength(html) > 6800000);
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  assert.match(url, /^https:\/\/storage\.invalid\/storage\/v1\/object\/public\/pages\/[a-f0-9]{48}\.html$/);
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  chamadas.push(['fetch', url, options.method]);
  if (storageFalha) throw new TypeError('Falha de rede mock');
  if (storageStatus !== 200) return new Response(null, { status: storageStatus });
  // Se o handler acumular o corpo com text()/arrayBuffer(), o teste falha.
  // Serve o último HTML enviado no upload (enviado) ou o HTML base para os testes de leitura.
  const bytes = Buffer.from(enviado !== null ? enviado : html);
  let offset = 0;
  const body = options.method === 'HEAD' ? null : new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 65536, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  });
  const response = new Response(body, { headers: {
    'Content-Type': 'text/plain', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Length': String(bytes.length)
  } });
  response.text = response.arrayBuffer = () => { throw new Error('Resposta não deve ser acumulada'); };
  return response;
};

let server;
let base;
let apiConfig;
let cookieAdmin = '';
before(async () => {
  // Exercita as rotas do servidor real, mas em porta efêmera e com Supabase mockado.
  const originalListen = express.application.listen;
  express.application.listen = function () {
    server = originalListen.call(this, 0, '127.0.0.1');
    return server;
  };
  try { require('../server'); } finally { express.application.listen = originalListen; }
  await once(server, 'listening');
  // O build Vercel transpila exports ESM em .js para CommonJS. Aqui só simulamos
  // essa transformação, sem alegar que este teste substitui vercel build/deploy.
  const arquivo = path.resolve(__dirname, '../api/pagina.js');
  const source = fs.readFileSync(arquivo, 'utf8')
    .replace('export const config =', 'exports.config =')
    .replace('export default', 'exports.default =');
  const sandbox = { exports: {}, require: createRequire(arquivo) };
  vm.runInNewContext(source, sandbox, { filename: arquivo });
  apiConfig = sandbox.exports.config;
  // Express disponibiliza req.query, como o adaptador Node da Vercel.
  server.listeners('request')[0].get('/api/pagina', sandbox.exports.default);

  base = 'http://127.0.0.1:' + server.address().port;
  // sessão de administrador para os testes (fluxo completo: registro + 2FA)
  process.env.ADMIN_EMAILS = 'admin@teste.local';
  const registro = await realFetch(base + '/api/auth/registrar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@teste.local', nome: 'Admin', senha: 'senha-admin-1' })
  });
  const registroJson = await registro.json();
  assert.equal(registroJson.ok, true, 'registro do admin');
  const cookiePendente = (registro.headers.get('set-cookie') || '').match(/sessao=([a-f0-9]+)/)[1];
  const verificacao = await realFetch(base + '/api/auth/2fa/verificar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'sessao=' + cookiePendente },
    body: JSON.stringify({ codigo: auth.codigoTotp(registroJson.twofa.secret) })
  });
  const verificacaoJson = await verificacao.json();
  assert.equal(verificacaoJson.ok, true, 'verificação do 2FA');
  cookieAdmin = 'sessao=' + ((verificacao.headers.get('set-cookie') || '').match(/sessao=([a-f0-9]+)/)[1]);
});
after(async () => {
  global.fetch = realFetch;
  if (server) await new Promise(resolve => server.close(resolve));
});

for (const rota of ['/' + TOKEN, '/api/pagina?token=' + TOKEN]) {
  test('HTML > 6,8 MB, sem buffer nem CSP herdado: ' + rota, async () => {
    const response = await realFetch(base + rota);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('content-security-policy'), null);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('transfer-encoding'), 'chunked');
    assert.equal(await response.text(), html);
    assert.ok(html.startsWith('<html'));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html));
    assert.ok(html.includes('Teste visual &amp; renderização'));
    assert.ok(html.includes('Linha 1<br>Linha 2 &lt;segura&gt;'));
  });
  test('HEAD sem corpo: ' + rota, async () => {
    const response = await realFetch(base + rota, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('content-security-policy'), null);
    assert.equal(await response.text(), '');
    assert.equal(chamadas.at(-1)[2], 'HEAD');
  });
  test('Storage inexistente/falha: ' + rota, async () => {
    try {
      for (const method of ['GET', 'HEAD']) {
        for (const status of [400, 404, 403, 500]) {
          storageStatus = status;
          const response = await realFetch(base + rota, { method });
          assert.equal(response.status, [400, 404].includes(status) ? 404 : 502);
          assert.equal(response.headers.get('content-security-policy'), null);
          const body = await response.text();
          if (method === 'HEAD') assert.equal(body, '');
          else assert.ok(body.length > 0);
        }
      }
      storageStatus = 200;
      storageFalha = true;
      assert.equal((await realFetch(base + rota)).status, 502);
    } finally { storageStatus = 200; storageFalha = false; }
  });
}

test('Tokens inválidos, arrays e travessia não acessam Storage', async () => {
  const antes = chamadas.length;
  for (const rota of ['/invalido', '/' + 'a'.repeat(47), '/' + 'A'.repeat(48),
    '/api/pagina', '/api/pagina?token=..%2Fsegredo',
    '/api/pagina?token=' + TOKEN + '&token=' + TOKEN,
    '/api/pagina?token[x]=' + TOKEN]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await realFetch(base + rota, { method });
      assert.equal(response.status, 404);
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
  }
  assert.equal(chamadas.length, antes);
});

test('Toggles exibir removem as seções da página gerada', async () => {
  const resposta = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ titulo: 'Sem seções', empresa: 'E', nota: 'NOTA9X', num_avaliacoes: 'NUMAV9X', classificacao: 'CLAS9X', downloads: 'DOWNL9X', atualizado_em: 'ATUAL9X', disponivel_em: 'DISP9X', descricao: 'DESC9X', descricao_curta: 'CURTA9X', screenshots: [], comentarios: [{ nome: 'NOMEC9X', texto: 'TEXTOC9X' }],
      exibir: { nota: false, num_avaliacoes: false, classificacao: false, downloads: false, atualizado: false, disponivel: false, descricao: false, screenshots: false, comentarios: false } })
  });
  const resultado = await resposta.json();
  assert.equal(resultado.ok, true);
  assert.deepEqual(linha.exibir, { nota: false, num_avaliacoes: false, classificacao: false, downloads: false, atualizado: false, disponivel: false, descricao: false, screenshots: false, comentarios: false });
  const pagina = await realFetch(base + resultado.url);
  const texto = await pagina.text();
  for (const ausente of ['NOTA9X', 'NUMAV9X', 'CLAS9X', 'DOWNL9X', 'ATUAL9X', 'DISP9X', 'DESC9X', 'NOMEC9X', 'TEXTOC9X', 'Sobre este jogo', 'Classificações e resenhas']) {
    // CURTA9X pode aparecer: é a meta description do preview no WhatsApp, campo separado
    assert.ok(!texto.includes(ausente), 'seção desligada apareceu: ' + ausente);
  }
  // com tudo ligado, tudo presente
  const resposta2 = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ titulo: 'Com seções', empresa: 'E', nota: 'NOTA9Y', num_avaliacoes: 'NUMAV9Y', classificacao: 'CLAS9Y', downloads: 'DOWNL9Y', atualizado_em: 'ATUAL9Y', disponivel_em: 'DISP9Y', descricao: 'DESC9Y', screenshots: [], comentarios: [{ nome: 'NOMEC9Y', texto: 'TEXTOC9Y' }] })
  });
  const r2 = await resposta2.json();
  assert.equal(r2.ok, true);
  const pagina2 = await realFetch(base + r2.url);
  const texto2 = await pagina2.text();
  for (const presente of ['NOTA9Y', 'NUMAV9Y', 'CLAS9Y', 'DOWNL9Y', 'ATUAL9Y', 'DISP9Y', 'DESC9Y', 'NOMEC9Y', 'TEXTOC9Y', 'Sobre este jogo', 'Classificações e resenhas']) {
    assert.ok(texto2.includes(presente), 'seção ligada sumiu: ' + presente);
  }
});

test('Classificação indicativa: select troca selo e texto na página gerada', async () => {
  for (const [enviar, imgEsperada, textoEsperado] of [
    ['18', 'ClassInd_18_272.png', 'Classificação 18 anos'],
    ['Livre', 'ClassInd_L_272.png', '>Livre<'],
    ['14', 'ClassInd_14_272.png', 'Classificação 14 anos'],
    // retrocompatibilidade: texto livre antigo vira selo pelo número
    ['Classificação 12 anos', 'ClassInd_12_272.png', 'Classificação 12 anos']
  ]) {
    const resposta = await realFetch(base + '/api/gerar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ titulo: 'T', empresa: 'E', descricao: 'D', classificacao: enviar, screenshots: [] })
    });
    const r = await resposta.json();
    assert.equal(r.ok, true, enviar);
    assert.equal(linha.classificacao, enviar);
    assert.ok(enviado.includes(imgEsperada), imgEsperada + ' para ' + enviar);
    assert.ok(!enviado.includes('ClassInd_Livre'), 'nome antigo de arquivo não pode aparecer');
    assert.ok(enviado.includes(textoEsperado), textoEsperado + ' para ' + enviar);
    assert.ok(!enviado.includes('{{CLASSIF}}'), 'placeholder de selo não preenchido');
  }
});

test('Config Vercel: rewrite interno, streaming explícito e duração', () => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../vercel.json'), 'utf8'));
  const route = config.rewrites[0];
  const match = require('path-to-regexp')(route.source).exec('/' + TOKEN);
  assert.equal(match[1], TOKEN);
  const destino = new URL(route.destination.replace(':token', match[1]), 'https://app.invalid');
  assert.equal(destino.pathname, '/api/pagina');
  assert.equal(destino.searchParams.get('token'), TOKEN);
  assert.equal(apiConfig.supportsResponseStreaming, true);
  assert.equal(apiConfig.maxDuration, 60);
});

test('API de página rejeita métodos de escrita', async () => {
  // No Express local o POST nem chega ao handler (rota GET); a Vercel, sim.
  const { pagina } = require('../lib/handlers');
  const res = { headersSent: false, statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { this.headersSent = true; } };
  await pagina({ method: 'POST', params: {}, query: { token: TOKEN } }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, HEAD');
  assert.ok(res.headersSent);
});

test('Gerador retorna link funcional, sem escrever em produção', async () => {
  const response = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ titulo: 'Campanha mock', empresa: 'Empresa', descricao: 'Descrição', icone_url: 'https://images.invalid/icon.png', screenshots: [],
    descricao_curta: 'Resumo curto da página',
    comentarios: [
      { nome: 'Maria <b>Teste</b>', estrelas: '4', data: '1 de janeiro de 2027', texto: 'Ótimo jogo\nRecomendo', foto: 'https://images.invalid/foto.png', util: '12' },
      { nome: 'Sem foto', estrelas: '1', texto: 'Uma estrela' }
    ] })
  });
  const resultado = await response.json();
  assert.equal(response.status, 200);
  assert.equal(resultado.ok, true);
  assert.match(resultado.url, /^\/[a-f0-9]{48}$/);
  assert.equal(linha.token, resultado.url.slice(1));
  assert.ok(enviado.startsWith('<html'));
  assert.ok(enviado.includes('Campanha mock'));
  // comentários dinâmicos
  assert.ok(!enviado.includes('{{COMENTARIOS}}'), 'placeholder de comentários não preenchido');
  assert.ok(enviado.includes('Maria &lt;b&gt;Teste&lt;/b&gt;'), 'nome não escapado');
  assert.ok(enviado.includes('Avaliado com 4 de 5 estrelas'));
  assert.ok(enviado.includes('https://images.invalid/foto.png'));
  assert.ok(enviado.includes('Ótimo jogo<br>Recomendo'));
  assert.ok(enviado.includes('útil por 12 pessoas'));
  assert.ok(enviado.includes('Avaliado com 1 de 5 estrelas'));
  assert.equal((enviado.match(/class="EGFGHd"/g) || []).length, 4, 'esperava 4 blocos de comentário (2 comentários × 2 variantes)');
  // pré-visualização no WhatsApp/redes: Open Graph por campanha
  assert.ok(enviado.includes('<title>Campanha mock – Apps no Google Play</title>'), 'title da página');
  assert.ok(enviado.includes('og:title" content="Campanha mock – Apps no Google Play"'));
  assert.ok(enviado.includes('og:description" content="Resumo curto da página"'));
  assert.ok(enviado.includes('og:site_name" content="Google Play"'));
  assert.ok(enviado.includes('og:image" content="https://images.invalid/icon.png"'), 'ícone como imagem do preview');
  assert.ok(enviado.indexOf('og:title') < enviado.indexOf('googletagmanager'), 'metas no início do head');
  const pagina = await realFetch(base + resultado.url);
  assert.equal(pagina.status, 200);
  await pagina.body.cancel();
});

test('Falha no banco limpa somente o upload mockado da campanha', async () => {
  dbFalha = true;
  try {
    const response = await realFetch(base + '/api/gerar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin }, body: '{}'
    });
    assert.equal(response.status, 500);
    assert.deepEqual(chamadas.at(-1), ['remove', 'pages', [linha.token + '.html']]);
  } finally { dbFalha = false; }
});

test('APK: upload assinado com nome amigável e download automático na página gerada', async () => {
  const resposta = await realFetch(base + '/api/upload-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Subway Surfers City.apk' })
  });
  const upload = await resposta.json();
  assert.equal(upload.ok, true);
  assert.match(upload.uploadUrl, /subway-surfers-city-[a-f0-9]{6}\.apk$/);

  // gerar com apk_url: script injetado no <head> usando o endpoint interno
  const url = 'https://images.invalid/subway-surfers-city-a1b2c3.apk';
  const g = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ titulo: 'T', empresa: 'E', descricao: 'D', screenshots: [], apk_url: url })
  });
  const r = await g.json();
  assert.equal(r.ok, true);
  assert.equal(linha.apk_url, url);
  assert.ok(enviado.includes('aria-label=\\"Instalar Agora\\"'), 'seletor do botão no script');
  assert.ok(enviado.includes('/api/download?token='), 'endpoint interno no script');
  assert.ok(enviado.includes('"' + linha.token + '"'), 'token da campanha no script');
  assert.ok(!enviado.includes('supabase.co'), 'link do Supabase não pode aparecer na página');
  assert.ok(enviado.indexOf('var D=') < enviado.indexOf('googletagmanager'), 'script do download antes dos scripts do template');

  // sem APK: script não é injetado
  const g2 = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ titulo: 'T', empresa: 'E', descricao: 'D', screenshots: [] })
  });
  const r2 = await g2.json();
  assert.equal(r2.ok, true);
  assert.equal(linha.apk_url, '');
  assert.ok(!enviado.includes('Instalar Agora\\"'), 'sem APK não deve ter script de download');
  // URL inválida é descartada
  const g3 = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ titulo: 'T', empresa: 'E', descricao: 'D', screenshots: [], apk_url: 'javascript:alert(1)' })
  });
  const r3 = await g3.json();
  assert.equal(r3.ok, true);
  assert.equal(linha.apk_url, '');
});

test('Health (keep-alive): consulta leve e resposta ok', async () => {
  const resposta = await realFetch(base + '/api/health');
  const corpo = await resposta.json();
  assert.equal(resposta.status, 200);
  assert.equal(corpo.ok, true);
  assert.match(corpo.em, /^\d{4}-/);
  // POST rejeitado (no Express local a rota GET nem chega ao handler; na Vercel, sim)
  const res = { headersSent: false, statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { this.headersSent = true; } };
  await require('../lib/handlers').health({ method: 'POST' }, res);
  assert.equal(res.statusCode, 405);
});

test('Crawlers de preview (WhatsApp) recebem versão leve com Open Graph', async () => {
  const g = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ titulo: 'Crawler Teste', empresa: 'E', descricao: 'D', descricao_curta: 'Resumo do crawler',
      icone_url: 'https://images.invalid/icon.png', screenshots: [], apk_url: '' })
  });
  const r = await g.json();
  assert.equal(r.ok, true);
  const resposta = await realFetch(base + r.url, { headers: { 'User-Agent': 'WhatsApp/2.23.20.0' } });
  assert.equal(resposta.status, 200);
  assert.match(resposta.headers.get('content-type'), /^text\/html/);
  const corpo = await resposta.text();
  assert.ok(corpo.length < 5000, 'versão para crawler deve ser leve: ' + corpo.length);
  assert.ok(corpo.includes('<title>Crawler Teste – Apps no Google Play</title>'));
  assert.ok(corpo.includes('og:title" content="Crawler Teste – Apps no Google Play"'));
  assert.ok(corpo.includes('og:image" content="https://images.invalid/icon.png"'));
  assert.ok(corpo.includes('og:description" content="Resumo do crawler"'));
  assert.ok(!corpo.includes('ClassInd'), 'crawler não deve receber o HTML completo');
  // navegador comum continua recebendo a página completa
  const completa = await realFetch(base + r.url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome' } });
  const tamanho = Number(completa.headers.get('content-length')) || (await completa.text()).length;
  assert.ok(tamanho > 6000000, 'navegador deve receber a página completa');
});

test('Upload assinado e listagem preservados', async () => {
  const response = await realFetch(base + '/api/upload-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin }, body: JSON.stringify({ nome: 'icone.png' })
  });
  const upload = await response.json();
  assert.equal(upload.ok, true);
  assert.match(upload.uploadUrl, /^https:\/\/upload\.invalid\/midia\/[a-f0-9]{32}\.png$/);
  const lista = await realFetch(base + '/api/campanhas', { headers: { Cookie: cookieAdmin } });
  const listaJson = await lista.json();
  assert.equal(listaJson.ok, true);
  assert.ok(listaJson.apps.length > 0);
  assert.ok(listaJson.apps.every(a => 'token' in a && 'titulo' in a && 'dias_restantes' in a), 'formato do painel admin');
});

test('Formulário usa upload direto e mostra o link da aplicação', async () => {
  const response = await realFetch(base + '/dashboard.html');
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const form = await response.text();
  for (const trecho of ["fetch('/api/upload-url'", "fetch(j.uploadUrl", "method: 'PUT'",
    "fetch('/api/gerar'", 'link.href = j.url', 'location.origin + j.url', 'Página gerada com sucesso!']) {
    assert.ok(form.includes(trecho), trecho);
  }
});
