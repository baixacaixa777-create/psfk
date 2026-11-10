// Mock genérico do cliente Supabase: banco em memória suficiente para os fluxos
// do projeto (sessões, usuários, campanhas) sem tocar em produção.
function criarMockSupabase(db) {
  db = db || { usuarios: [], sessoes: [], campanhas: [] };

  // separa os campos respeitando parênteses de joins aninhados
  function separar(campos) {
    const partes = [];
    let prof = 0, atual = '';
    for (const ch of campos) {
      if (ch === '(') prof++;
      if (ch === ')') prof--;
      if (ch === ',' && prof === 0) { partes.push(atual); atual = ''; } else atual += ch;
    }
    if (atual) partes.push(atual);
    return partes;
  }

  function expandir(campos, linha) {
    // resolve selects com join embutido, ex.: sessoes(...usuarios(email,...))
    const saida = {};
    for (const bruto of separar(campos)) {
      const campo = bruto.trim();
      const m = campo.match(/^(\w+)\(([^)]*)\)$/);
      if (m) {
        const tabela = m[1];
        const relacao = db[tabela] ? db[tabela].find(u => u.id === linha[tabela.slice(0, -1) + '_id']) : null;
        saida[tabela] = relacao ? expandir(m[2], relacao) : null;
      } else {
        saida[campo] = linha[campo] ?? null;
      }
    }
    return saida;
  }

  function consulta(tabelaDb, campos, filtros) {
    return {
      eq(campo, valor) {
        return consulta(tabelaDb, campos, [...filtros, [campo, valor]]);
      },
      order(campo, options) {
        const dir = options && options.ascending ? 1 : -1;
        const dados = tabelaDb.filter(l => filtros.every(([c, v]) => l[c] === v))
          .sort((a, b) => dir * ((a[campo] > b[campo]) - (a[campo] < b[campo])));
        return Promise.resolve({ data: dados.map(l => expandir(campos, l)), error: null });
      }
    };
  }

  function terminal(tabelaDb, campos, filtros, forcarUm) {
    const dados = tabelaDb.filter(l => filtros.every(([c, v]) => l[c] === v));
    const achou = forcarUm ? dados[0] : (dados[0] || null);
    const erro = forcarUm && !achou ? { message: 'não encontrado' } : null;
    return Promise.resolve({ data: achou ? expandir(campos, achou) : null, error: erro });
  }

  function seletor(tabelaDb, campos, head) {
    const base = { filtros: [] };
    const contados = () => tabelaDb.filter(l => base.filtros.every(([c, v]) => l[c] === v));
    const resultado = {
      eq(campo, valor) {
        base.filtros.push([campo, valor]);
        return resultado;
      },
      single: () => terminal(tabelaDb, campos, base.filtros, true),
      maybeSingle: () => terminal(tabelaDb, campos, base.filtros, false),
      order(campo, options) { return consulta(tabelaDb, campos, base.filtros).order(campo, options); }
    };
    // select(..., { count, head }) é thenável e devolve o count (com os filtros)
    if (head) resultado.then = (ok) => ok({ count: contados().length, error: null });
    return resultado;
  }

  return {
    db,
    storage: {
      from(bucket) {
        return {
          getPublicUrl(arquivo) { return { data: { publicUrl: 'https://storage.invalid/storage/v1/object/public/' + bucket + '/' + arquivo } }; },
          async upload(arquivo, buffer, options) { return { error: null, dados: [bucket, arquivo] }; },
          async remove(arquivos) { return { error: null, removidos: arquivos }; },
          async createSignedUploadUrl(arquivo) { return { data: { signedUrl: 'https://upload.invalid/' + bucket + '/' + arquivo }, error: null }; },
          async list(pasta, options) { return { data: [], error: null }; }
        };
      }
    },
    from(tabela) {
      const t = db[tabela] || (db[tabela] = []);
      return {
        insert(linha) {
          const linhas = Array.isArray(linha) ? linha : [linha];
          const crypto = require('crypto');
          linhas.forEach(l => t.push({ id: crypto.randomUUID(), ...l }));
          const ultima = t[t.length - 1];
          return {
            select(campos) { return { single: async () => ({ data: expandir(campos, ultima), error: null }) }; },
            error: null
          };
        },
        select(campos, options) {
          return seletor(t, campos, options && options.head);
        },
        update(mudancas) {
          return { eq(campo, valor) {
            const alvo = t.find(l => l[campo] === valor);
            if (alvo) Object.assign(alvo, mudancas);
            return { data: alvo || null, error: null };
          } };
        },
        delete() {
          return { eq(campo, valor) {
            const i = t.findIndex(l => l[campo] === valor);
            if (i >= 0) t.splice(i, 1);
            return { data: null, error: null };
          } };
        }
      };
    }
  };
}

module.exports = { criarMockSupabase };
