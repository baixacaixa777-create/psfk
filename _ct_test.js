require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.log('FALTA_ENV'); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const nome = 'ct_test_' + Date.now() + '.html';
const html = '<!doctype html><html><head><meta charset="utf-8"><title>ct</title></head><body>ok</body></html>';

(async () => {
  const { error: upErr } = await sb.storage.from('pages').upload(nome, Buffer.from(html, 'utf8'), {
    contentType: 'text/html; charset=utf-8',
    cacheControl: '31536000',
    upsert: true,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
  if (upErr) { console.log('UPLOAD_ERRO: ' + upErr.message); process.exit(1); }

  const pub = sb.storage.from('pages').getPublicUrl(nome).data.publicUrl;
  const r = await fetch(pub, { method: 'HEAD' });
  console.log('PUBLIC_URL: ' + pub);
  console.log('HEAD_STATUS: ' + r.status);
  console.log('HEAD_CONTENT_TYPE: ' + (r.headers.get('content-type') || '(null)'));

  const { error: rmErr } = await sb.storage.from('pages').remove([nome]);
  console.log(rmErr ? ('REMOVE_ERRO: ' + rmErr.message) : 'REMOVE_OK');
})();
