const crypto = require('crypto');
const path = require('path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const supabase = require('./supabase');
const { gerarHtml, esc } = require('./gerarHtml');
const sessao = require('./sessao');
const contas = require('./contas');

const EXT_OK = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.apk'];
const TOKEN_RE = /^[a-f0-9]{48}$/;

// APKs ganham nome legível no download (ex.: meu-jogo-a1b2c3.apk)
function caminhoDeUpload(nome, ext) {
  if (ext !== '.apk') return crypto.randomBytes(16).toString('hex') + ext;
  const slug = path.basename(nome, ext).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';
  return slug + '-' + crypto.randomBytes(3).toString('hex') + '.apk';
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function lerJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); }
    });
  });
}

async function uploadUrl(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const guard = await sessao.autorizar(req);
  if (guard.falha) return sessao.negar(res, guard);
  try {
    const { nome } = await lerJson(req);
    const ext = path.extname(nome || '').toLowerCase();
    if (!EXT_OK.includes(ext)) {
      return json(res, 400, { ok: false, erro: 'Formato inválido (use png, jpg, webp, gif ou apk)' });
    }
    const caminho = caminhoDeUpload(String(nome || ''), ext);
    const { data, error } = await supabase.storage.from('midia').createSignedUploadUrl(caminho);
    if (error) throw error;
    const { data: pub } = supabase.storage.from('midia').getPublicUrl(caminho);
    json(res, 200, { ok: true, uploadUrl: data.signedUrl, publicUrl: pub.publicUrl });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

async function gerar(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const guard = await sessao.autorizar(req);
  if (guard.falha) return sessao.negar(res, guard);
  try {
    // limite de apps por plano (protege o Storage do plano gratuito)
    const { count } = await supabase.from('campanhas')
      .select('token', { count: 'exact', head: true }).eq('usuario_id', guard.usuario.id);
    const limite = contas.LIMITES_APPS[guard.usuario.plano];
    if (Number.isFinite(limite) && (count || 0) >= limite) {
      return json(res, 403, { ok: false, erro: 'Limite de apps do plano ' + guard.usuario.plano +
        ' atingido (' + limite + '). Renove a assinatura ou mude de plano.' });
    }
    const b = await lerJson(req);
    const token = crypto.randomBytes(24).toString('hex');
    const EXIBIR_PADRAO = {
      nota: true, num_avaliacoes: true, classificacao: true, downloads: true,
      atualizado: true, disponivel: true, descricao: true, screenshots: true, comentarios: true
    };
    const exibir = Object.assign({}, EXIBIR_PADRAO);
    for (const k of Object.keys(EXIBIR_PADRAO)) {
      if (b.exibir && typeof b.exibir[k] === 'boolean') exibir[k] = b.exibir[k];
    }
    const campanha = {
      token,
      titulo: b.titulo || '',
      empresa: b.empresa || '',
      dev_id: b.dev_id || '',
      nota: b.nota || '',
      num_avaliacoes: b.num_avaliacoes || '',
      classificacao: b.classificacao || '',
      downloads: b.downloads || '',
      descricao: b.descricao || '',
      descricao_curta: b.descricao_curta || String(b.descricao || '').slice(0, 120),
      atualizado_em: b.atualizado_em || '',
      disponivel_em: b.disponivel_em || '',
      icone_url: b.icone_url || '',
      screenshots: Array.isArray(b.screenshots) ? b.screenshots.slice(0, 20) : [],
      comentarios: Array.isArray(b.comentarios)
        ? b.comentarios.slice(0, 20).map((c) => ({
            id: crypto.randomUUID(),
            nome: String(c && c.nome || '').slice(0, 80),
            estrelas: Math.min(5, Math.max(1, parseInt(c && c.estrelas, 10) || 0) || 5),
            data: String(c && c.data || '').slice(0, 40),
            texto: String(c && c.texto || '').slice(0, 2000),
            foto: /^https?:\/\//i.test(String(c && c.foto || '')) ? String(c.foto).slice(0, 1000) : '',
            util: Math.max(0, parseInt(c && c.util, 10) || 0)
          }))
        : [],
      apk_url: /^https?:\/\//i.test(String(b.apk_url || '')) ? String(b.apk_url).slice(0, 1000) : '',
      exibir,
      usuario_id: guard.usuario.id,
      expira_em: contas.expiracaoPadrao()
    };

    const html = gerarHtml(campanha);
    const arquivo = token + '.html';
    const { error: upErr } = await supabase.storage.from('pages').upload(
      arquivo,
      Buffer.from(html, 'utf8'),
      {
        contentType: 'text/html; charset=utf-8',
        cacheControl: '31536000',
        upsert: true,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }
    );
    if (upErr) throw upErr;

    const { error: dbErr } = await supabase.from('campanhas').insert(campanha);
    if (dbErr) {
      await supabase.storage.from('pages').remove([arquivo]);
      throw dbErr;
    }

    json(res, 200, { ok: true, url: '/' + token });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

async function campanhas(req, res) {
  // agora é rota administrativa (a lista pública do cliente é /api/meus-apps)
  const admin = require('./admin');
  return admin.apps(req, res);
}

async function download(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const token = (req.params && req.params.token) || (req.query && req.query.token) || '';
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    res.statusCode = 404;
    return res.end('Arquivo não encontrado');
  }
  try {
    const { data: linha, error } = await supabase.from('campanhas').select('apk_url,titulo').eq('token', token).single();
    if (error || !linha || !linha.apk_url) {
      res.statusCode = 404;
      return res.end('Arquivo não encontrado');
    }
    // só caminhos do bucket midia são aceitos
    const m = String(linha.apk_url).match(/\/object\/public\/midia\/([^/?#]+)/);
    if (!m) {
      res.statusCode = 502;
      return res.end('Erro ao carregar arquivo');
    }
    const arquivo = decodeURIComponent(m[1]);
    const { data: pub } = supabase.storage.from('midia').getPublicUrl(arquivo);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const r = await fetch(pub.publicUrl, { redirect: 'error', signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok || !r.body) {
      res.statusCode = r.status === 404 ? 404 : 502;
      return res.end('Arquivo não encontrado');
    }
    // nome amigável derivado do título; o link do Storage nunca aparece para o visitante
    const nome = String(linha.titulo || 'app').replace(/["\\\r\n]/g, '').trim().slice(0, 60) || 'app';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nome + '.apk"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const len = r.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    if (req.method === 'HEAD') {
      if (r.body) await r.body.cancel();
      return res.end();
    }
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (e) {
    console.error('Erro no download:', e.name);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end('Erro ao carregar arquivo');
    } else if (!res.destroyed) res.destroy();
  }
}

async function health(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  try {
    // consulta mínima: só para manter o projeto Supabase ativo
    const { error } = await supabase.from('campanhas').select('token', { count: 'exact', head: true });
    if (error) throw error;
    // aviso de vencimento: marca apps que vencem em até 3 dias (o painel do dono mostra)
    let avisos = 0;
    try {
      const limite = new Date(Date.now() + 3 * 864e5).toISOString();
      const { data: vencendo } = await supabase.from('campanhas')
        .select('token,expira_em').eq('aviso_3d', false).lte('expira_em', limite).gt('expira_em', new Date().toISOString());
      for (const a of (vencendo || [])) {
        const { error: e2 } = await supabase.from('campanhas').update({ aviso_3d: true }).eq('token', a.token);
        if (!e2) avisos++;
      }
    } catch (e2) { /* aviso é acessório: não derruba o ping */ }
    json(res, 200, { ok: true, em: new Date().toISOString(), avisos_vencimento: avisos });
  } catch (e) {
    json(res, 500, { ok: false, erro: e.message });
  }
}

// Crawlers de preview (WhatsApp, Telegram, Facebook...) recebem uma versão
// mínima e instantânea com as Open Graph: o HTML completo de ~6,8 MB estoura
// o tempo do robô e faz o preview não aparecer.
const RE_CRAWLERS = /WhatsApp|facebookexternalhit|Twitterbot|Slackbot|TelegramBot|Discordbot|LinkedInBot|SkypeUriPreview|IABBot|applebot|embedly|quora link preview|outbrain|vkshare/i;

function paginaLeve(req, campanha, token, res) {
  const titulo = esc(String((campanha && campanha.titulo) || '').trim().slice(0, 80) || 'Apps no Google Play');
  const descricao = esc(String((campanha && campanha.descricao_curta) || '').slice(0, 160));
  const icone = campanha && /^https?:\/\//i.test(String(campanha.icone_url || ''))
    ? esc(String(campanha.icone_url).slice(0, 1000)) : '';
  const corpo = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + titulo + ' – Apps no Google Play</title>' +
    '<meta property="og:title" content="' + titulo + ' – Apps no Google Play">' +
    '<meta property="og:description" content="' + descricao + '">' +
    (icone ? '<meta property="og:image" content="' + icone + '">' +
      '<meta property="og:image:alt" content="' + titulo + '">' : '') +
    '<meta property="og:type" content="website">' +
    '<meta property="og:site_name" content="Google Play">' +
    '<meta name="twitter:card" content="summary">' +
    '</head><body></body></html>';
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Length', String(Buffer.byteLength(corpo)));
  res.end(req.method === 'HEAD' ? undefined : corpo);
}

async function pagina(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return json(res, 405, { ok: false, erro: 'Método não permitido' });
  }
  const token = (req.params && req.params.token) ?? (req.query && req.query.token) ?? '';
  const erro = (status, mensagem) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : mensagem);
  };
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    return erro(404, 'Página não encontrada');
  }
  // crawlers de preview recebem a versão leve com as Open Graph
  const agente = String((req.headers && req.headers['user-agent']) || '');
  if (RE_CRAWLERS.test(agente)) {
    try {
      const { data: campanha } = await supabase.from('campanhas')
        .select('titulo,icone_url,descricao_curta,expira_em').eq('token', token).single();
      if (campanha && campanha.expira_em && new Date(campanha.expira_em) < new Date()) {
        res.statusCode = 404;
        return res.end('Página não encontrada');
      }
      Promise.resolve(supabase.from('acessos').insert({ token, user_agent: agente.slice(0, 200) })).catch(() => {});
      return paginaLeve(req, campanha, token, res);
    } catch (e) {
      // sem dados da campanha, preview básico sem bloquear o robô
      return paginaLeve(req, null, token, res);
    }
  }
  // prazo de expiração: página vencida sai do ar (campanhas antigas sem prazo continuam)
  let vencida = false;
  try {
    const { data: registro } = await supabase.from('campanhas')
      .select('expira_em').eq('token', token).maybeSingle();
    if (registro && registro.expira_em && new Date(registro.expira_em) < new Date()) vencida = true;
  } catch (e) { /* banco indisponível não derruba a página */ }
  if (vencida) {
    return erro(404, 'Página não encontrada');
  }
  if (req.method === 'GET') {
Promise.resolve(supabase.from('acessos').insert({ token, user_agent: String(agente || '').slice(0, 200) })).catch(() => {});
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const cancelar = () => controller.abort();
  res.once('close', cancelar);
  try {
    const { data } = supabase.storage.from('pages').getPublicUrl(token + '.html');
    const arquivo = await fetch(data.publicUrl, {
      method: req.method,
      redirect: 'error',
      signal: controller.signal
    });
    if (!arquivo.ok) {
      if (arquivo.body) await arquivo.body.cancel();
      const status = [400, 404].includes(arquivo.status) ? 404 : 502;
      return erro(status, status === 404 ? 'Página não encontrada' : 'Erro ao carregar página');
    }
    if (req.method === 'GET' && !arquivo.body) throw new Error('Storage sem corpo');
    // Não repassar Content-Type/CSP do Storage. api/pagina.js habilita streaming
    // também no runtime Vercel, evitando o limite de 4,5 MB de respostas em buffer.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') {
      if (arquivo.body) await arquivo.body.cancel();
      return res.end();
    }
    res.flushHeaders();
    await pipeline(Readable.fromWeb(arquivo.body), res);
  } catch (e) {
    console.error('Erro ao servir página:', e.name);
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    erro(502, 'Erro ao carregar página');
  } finally {
    clearTimeout(timeout);
    res.off('close', cancelar);
  }
}

module.exports = { uploadUrl, gerar, campanhas, pagina, health, download };
