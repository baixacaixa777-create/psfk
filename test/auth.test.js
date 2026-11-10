const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const auth = require('../lib/auth');
const { once } = require('node:events');
const { criarMockSupabase } = require('./mock-supabase');

// banco em memória e mocks — nada toca produção
const db = { usuarios: [], sessoes: [], campanhas: [] };
const supabasePath = require.resolve('../lib/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: criarMockSupabase(db) };

const realFetch = global.fetch;
let enviado = null; // último HTML no bucket pages
let apkNoStorage = null; // conteúdo fake do APK
global.fetch = async (url, options) => {
  if (String(url).includes('/midia/')) {
    const apk = Buffer.from(apkNoStorage || 'PK-fake');
    return new Response(apk, { headers: { 'Content-Length': String(apk.length) } });
  }
  assert.match(String(url), /\/pages\/[a-f0-9]{48}\.html$/);
  if (!enviado) return new Response(null, { status: 404 });
  return new Response(enviado, { headers: { 'Content-Type': 'text/html' } });
};

let server;
let base;
let cookieAdmin; // sessão completa do administrador

const post = async (caminho, corpo, cookie) => {
  const r = await realFetch(base + caminho, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
    body: JSON.stringify(corpo)
  });
  const tipo = r.headers.get('content-type') || '';
  if (!tipo.includes('json')) {
    console.error('DEBUG nao-json:', caminho, r.status, tipo, '|', (await r.clone().text()).slice(0, 150));
  }
  return r;
};
async function registrarCom2fa(email, plano) {
  const r = await post('/api/auth', { acao: 'registrar', email, nome: 'Cliente ' + email, senha: 'senha-cliente-1', plano: plano || 'mensal' });
  const j = await r.json();
  assert.equal(j.ok, true, 'registro de ' + email);
  const cookiePendente = r.headers.get('set-cookie').match(/sessao=([a-f0-9]+)/)[1];
  const v = await post('/api/auth', { acao: 'verificar', codigo: auth.codigoTotp(j.twofa.secret) }, 'sessao=' + cookiePendente);
  const vj = await v.json();
  assert.equal(vj.ok, true, '2FA de ' + email);
  return v.headers.get('set-cookie').match(/sessao=([a-f0-9]+)/)[1];
}

before(async () => {
  const originalListen = express.application.listen;
  express.application.listen = function () { server = originalListen.call(this, 0, '127.0.0.1'); return server; };
  try { require('../server'); } finally { express.application.listen = originalListen; }
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  cookieAdmin = 'sessao=' + await registrarCom2fa('chefe@teste.local');
  // conta admin precisa de admin=true: promover direto no banco de teste
  const conta = db.usuarios.find(u => u.email === 'chefe@teste.local');
  conta.admin = true;
});

after(async () => {
  global.fetch = realFetch;
  if (server) await new Promise(resolve => server.close(resolve));
});

test('Cadastro: sem 2FA a sessão fica pendente; com código libera', async () => {
  const cookiePendente = await (async () => {
    const r = await post('/api/auth', { acao: 'registrar', email: 'cliente1@teste.local', nome: 'Cliente 1', senha: 'senha-cliente-1', plano: 'trimestral' });
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.admin, false);
    const cookie = r.headers.get('set-cookie').match(/sessao=([a-f0-9]+)/)[1];
    // sessão pendente não acessa o gerador
    const gerarPendente = await realFetch(base + '/api/gerar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'sessao=' + cookie },
      body: JSON.stringify({ titulo: 'x' })
    });
    assert.equal(gerarPendente.status, 403);
    const v = await post('/api/auth', { acao: 'verificar', codigo: '000000' }, 'sessao=' + cookie);
    assert.equal((await v.json()).ok, false, 'código errado rejeitado');
    const v2 = await post('/api/auth', { acao: 'verificar', codigo: auth.codigoTotp(j.twofa.secret) }, 'sessao=' + cookie);
    assert.equal((await v2.json()).ok, true);
    return v2.headers.get('set-cookie').match(/sessao=([a-f0-9]+)/)[1];
  })();
  const eu = await realFetch(base + '/api/auth', { headers: { Cookie: 'sessao=' + cookiePendente } });
  const euJ = await eu.json();
  assert.equal(euJ.ok, true);
  assert.equal(euJ.usuario.plano, 'trimestral');
  assert.equal(euJ.usuario.assinatura_status, 'pendente');
});

test('Login com 2FA: senha correta exige código; errado rejeita', async () => {
  const r = await post('/api/auth', { acao: 'login', email: 'cliente1@teste.local', senha: 'senha-cliente-1' });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.pendente_2fa, true);
  const cookie = r.headers.get('set-cookie').match(/sessao=([a-f0-9]+)/)[1];
  const conta = db.usuarios.find(u => u.email === 'cliente1@teste.local');
  const errado = await post('/api/auth', { acao: 'verificar', codigo: '999999' }, 'sessao=' + cookie);
  assert.equal((await errado.json()).ok, false);
  const certo = await post('/api/auth', { acao: 'verificar', codigo: auth.codigoTotp(conta.twofa_secret) }, 'sessao=' + cookie);
  assert.equal((await certo.json()).ok, true);
});

test('Login sem senha correta rejeita', async () => {
  const r = await post('/api/auth', { acao: 'login', email: 'cliente1@teste.local', senha: 'errada-123' });
  assert.equal(r.status, 401);
});

test('Gerar exige sessão e registra dono + expiração', async () => {
  const semSessao = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titulo: 'x' })
  });
  assert.equal(semSessao.status, 401);
  const cookieCliente = 'sessao=' + await registrarCom2fa('cliente2@teste.local');
  const g = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieCliente },
    body: JSON.stringify({ titulo: 'Meu App', empresa: 'E', descricao: 'D', screenshots: [] })
  });
  const j = await g.json();
  assert.equal(j.ok, true);
  const campanha = db.campanhas.find(c => c.token === j.url.slice(1));
  assert.ok(campanha.usuario_id, 'dono registrado');
  assert.ok(new Date(campanha.expira_em) > new Date(), 'expiração no futuro');
  // meus apps lista só os do dono
  const lista = await realFetch(base + '/api/meus-apps', { headers: { Cookie: cookieCliente } });
  const lj = await lista.json();
  assert.equal(lj.ok, true);
  assert.equal(lj.apps.length, 1);
  assert.equal(lj.apps[0].titulo, 'Meu App');
  assert.equal(typeof lj.apps[0].dias_restantes, 'number');
});

test('Página expirada sai do ar', async () => {
  const cookieCliente = 'sessao=' + await registrarCom2fa('cliente3@teste.local');
  const g = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieCliente },
    body: JSON.stringify({ titulo: 'Vencida', empresa: 'E', descricao: 'D', screenshots: [] })
  });
  const j = await g.json();
  const campanha = db.campanhas.find(c => c.token === j.url.slice(1));
  campanha.expira_em = new Date(Date.now() - 864e5).toISOString(); // ontem
  const resposta = await realFetch(base + j.url);
  assert.equal(resposta.status, 404);
});

test('Limite por plano: quinzenal permite 5 apps e bloqueia o 6º', async () => {
  const cookieCliente = 'sessao=' + await registrarCom2fa('limitado@teste.local', 'quinzenal');
  const gerar = async () => realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieCliente },
    body: JSON.stringify({ titulo: 'App ' + Math.random(), empresa: 'E', descricao: 'D', screenshots: [] })
  });
  for (let i = 0; i < 5; i++) {
    const j = await (await gerar()).json();
    assert.equal(j.ok, true, 'app ' + (i + 1));
  }
  const sexto = await gerar();
  assert.equal(sexto.status, 403);
  const j6 = await sexto.json();
  assert.match(j6.erro, /Limite de apps do plano quinzenal/);
});

test('Painel admin: storage, apps, prazo e remoção', async () => {
  const cookieCliente = 'sessao=' + await registrarCom2fa('cliente4@teste.local');
  const g = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieCliente },
    body: JSON.stringify({ titulo: 'App do cliente 4', empresa: 'E', descricao: 'D', screenshots: [] })
  });
  const j = await g.json();
  const token = j.url.slice(1);
  // visão geral exige admin
  const semAdmin = await post('/api/admin', { acao: 'overview' }, cookieCliente);
  assert.equal(semAdmin.status, 403);
  const ov = await post('/api/admin', { acao: 'overview' }, cookieAdmin);
  const ovJ = await ov.json();
  assert.equal(ovJ.ok, true);
  assert.equal(ovJ.storage.usado_bytes, 0);
  assert.equal(ovJ.storage.limite_bytes, 1073741824);
  assert.equal(ovJ.storage.percentual, 0);
  assert.ok(ovJ.total_usuarios >= 5);
  assert.ok(ovJ.total_apps >= 1);
  // lista de apps com dono
  const apps = await post('/api/admin', { acao: 'apps' }, cookieAdmin);
  const appsJ = await apps.json();
  assert.equal(appsJ.ok, true);
  const app = appsJ.apps.find(a => a.token === token);
  assert.equal(app.dono, 'cliente4@teste.local');
  // alterar prazo
  const patch = await post('/api/admin', { acao: 'apps-editar', token, dias: 7 }, cookieAdmin);
  assert.equal((await patch.json()).ok, true);
  assert.equal(db.campanhas.find(c => c.token === token).expira_em.slice(0, 10), new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10));
  // remover app
  apkNoStorage = null;
  enviado = null;
  const del = await post('/api/admin', { acao: 'apagar-app', token }, cookieAdmin);
  assert.equal((await del.json()).ok, true);
  assert.ok(!db.campanhas.find(c => c.token === token));
});

test('Painel admin: usuários, assinaturas e 2FA ao vivo', async () => {
  const cookieCliente = 'sessao=' + await registrarCom2fa('cliente5@teste.local');
  const lista = await post('/api/admin', { acao: 'usuarios' }, cookieAdmin);
  const lj = await lista.json();
  assert.equal(lj.ok, true);
  const cliente = lj.usuarios.find(u => u.email === 'cliente5@teste.local');
  assert.equal(cliente.twofa_ativo, true);
  // o secret não vem na lista (só no banco) — o painel busca na hora do código ao vivo
  const conta5 = db.usuarios.find(u => u.email === 'cliente5@teste.local');
  // assinatura: plano + status + vencimento
  const patch = await post('/api/admin', { acao: 'usuarios-editar', id: cliente.id, plano: 'quinzenal', assinatura_status: 'ativa', vencer_dias: 15 }, cookieAdmin);
  assert.equal((await patch.json()).ok, true);
  const atualizado = db.usuarios.find(u => u.email === 'cliente5@teste.local');
  assert.equal(atualizado.plano, 'quinzenal');
  assert.equal(atualizado.assinatura_status, 'ativa');
  assert.ok(new Date(atualizado.assinatura_vence_em) > new Date());
  // 2FA ao vivo: código calculado bate e a barrinha anda (segundos entre 1 e 30)
  const cod1 = await post('/api/admin', { acao: '2fa', id: cliente.id }, cookieAdmin);
  const cod1J = await cod1.json();
  assert.equal(cod1J.ok, true);
  assert.ok([cod1J.codigo, cod1J.anterior].includes(auth.codigoTotp(conta5.twofa_secret)), 'código TOTP atual ou anterior');
  assert.ok(cod1J.segundos_restantes >= 1 && cod1J.segundos_restantes <= 30);
  // reset do 2FA: novo secret e cliente precisa reconfigurar
  const reset = await post('/api/admin', { acao: 'resetar-2fa', id: cliente.id }, cookieAdmin);
  const resetJ = await reset.json();
  assert.equal(resetJ.ok, true);
  const conta = db.usuarios.find(u => u.email === 'cliente5@teste.local');
  assert.equal(conta.twofa_ativo, false);
  assert.equal(conta.twofa_secret, resetJ.twofa.secret, 'novo secret instalado');
  assert.notEqual(conta.twofa_secret, cliente.twofa_secret, 'secret antigo substituído');
  // login agora exige reconfiguração (retorna o novo secret)
  const r = await post('/api/auth', { acao: 'login', email: 'cliente5@teste.local', senha: 'senha-cliente-1' });
  const rj = await r.json();
  assert.equal(rj.ok, true);
  assert.equal(rj.twofa.secret, conta.twofa_secret);
});

test('Download do APK pelo domínio próprio, sem expor o Storage', async () => {
  const cookieCliente = 'sessao=' + await registrarCom2fa('cliente6@teste.local');
  apkNoStorage = 'PK\x03\x04conteudo';
  const g = await realFetch(base + '/api/gerar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieCliente },
    body: JSON.stringify({ titulo: 'Meu Jogo & Cia', empresa: 'E', descricao: 'D', screenshots: [],
      apk_url: 'https://storage.invalid/storage/v1/object/public/midia/meu-jogo-a1b2c3.apk' })
  });
  const j = await g.json();
  const d = await realFetch(base + '/api/download?token=' + j.url.slice(1));
  assert.equal(d.status, 200);
  assert.match(d.headers.get('content-disposition'), /attachment; filename="Meu Jogo & Cia\.apk"/);
  assert.match(d.headers.get('content-type'), /android\.package-archive/);
  const corpo = await d.text();
  assert.ok(corpo.includes('conteudo'));
  // token sem APK
  const semApk = await realFetch(base + '/api/download?token=' + 'f'.repeat(48));
  assert.equal(semApk.status, 404);
});
