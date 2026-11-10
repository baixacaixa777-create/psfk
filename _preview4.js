// Servidor temporário: gerador estático + página gerada com classificação Livre.
const express=require('express');
const {gerarHtml}=require('./lib/gerarHtml');
const app=express();
app.use(express.static(__dirname+'/public'));
const png='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPScxMDgwJyBoZWlnaHQ9JzE5MjAnPjxyZWN0IHdpZHRoPScxMDAlJyBoZWlnaHQ9JzEwMCUnIGZpbGw9JyM0Mjg1ZjQnLz48L3N2Zz4=';
const avatar='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSczMicgaGVpZ2h0PSczMic+PGNpcmNsZSBjeD0nMTYnIGN5PScxNicgcj0nMTYnIGZpbGw9JyMwMTg3NWYnLz48L3N2Zz4=';
const html=gerarHtml({
  titulo:'AQUINO',empresa:'aquino company',dev_id:'7363891306616760846',nota:'3,8',
  num_avaliacoes:'218 mil avaliacoes',classificacao:'Livre',downloads:'9 mi+',
  descricao:'Teste',descricao_curta:'Teste',atualizado_em:'10 de nov',disponivel_em:'Android',
  icone_url:png,screenshots:[png,png],
  comentarios:[{nome:'Miss Fortune',estrelas:4,data:'10 de setembro de 2026',util:8,foto:avatar,texto:'O jogo e otimo!'}]
});
app.get('/:t([a-f0-9]{48})',(req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
app.listen(3993,'127.0.0.1',()=>console.log('ok'));
