const crypto = require('crypto');
const path = require('path');
const supabase = require('./supabase');
const { gerarHtml } = require('./gerarHtml');

const EXT_OK = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const TOKEN_RE = /^[a-f0-9]{48}$/;

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
  try {
    const { nome } = await lerJson(req);
    const ext = path.extname(nome || '').toLowerCase();
    if (!EXT_OK.includes(ext)) {
      return json(res, 400, { ok: false, erro: 'Formato inválido (use png, jpg, webp ou gif)' });
    }
    const caminho = crypto.randomBytes(16).toString('hex') + ext;
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
  try {
    const b = await lerJson(req);
    const token = crypto.randomBytes(24).toString('hex');
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
      screenshots: Array.isArray(b.screenshots) ? b.screenshots.slice(0, 20) : []
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
  if (req.method !== 'GET') return json(res, 405, { ok: false, erro: 'Método não permitido' });
  const { data, error } = await supabase
    .from('campanhas')
    .select('token,titulo,empresa,criado_em')
    .order('criado_em', { ascending: false });
  if (error) return json(res, 500, { ok: false, erro: error.message });
  json(res, 200, data);
}

async function pagina(req, res) {
  const token = (req.params && req.params.token) || '';
  if (!TOKEN_RE.test(token)) {
    res.statusCode = 404;
    return res.end('Página não encontrada');
  }
  const { data, error } = await supabase.storage.from('pages').download(token + '.html');
  if (error) {
    res.statusCode = 404;
    return res.end('Página não encontrada');
  }
  const html = Buffer.from(await data.arrayBuffer()).toString('utf8');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

module.exports = { uploadUrl, gerar, campanhas, pagina };
