const fs = require('fs');
const path = require('path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'views', 'template.html'), 'utf8');

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

function gerarHtml(row) {
  let html = TEMPLATE;
  html = html.replace(/\{\{TITULO\}\}/g, esc(row.titulo));
  html = html.replace(/\{\{EMPRESA\}\}/g, esc(row.empresa));
  html = html.replace(/\{\{DEV_ID\}\}/g, esc(row.dev_id));
  html = html.replace(/\{\{NOTA\}\}/g, esc(row.nota));
  html = html.replace(/\{\{NUM_AVALIACOES\}\}/g, esc(row.num_avaliacoes));
  html = html.replace(/\{\{CLASSIFICACAO\}\}/g, esc(row.classificacao));
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
  return html;
}

module.exports = { gerarHtml, esc };
