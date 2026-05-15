#!/usr/bin/env node
/**
 * 🔄 HINODE EXPRESS — SYNC (API VTEX oficial)
 *
 * Baixa o catálogo REAL da loja Hinode pela API pública de catálogo
 * da VTEX (JSON confiável, não regex em HTML) e regrava o bloco
 * PRODUCTS do index.html, mantendo o mesmo formato do site.
 *
 * USO:
 *   node sync-hinode.js                # sincroniza de verdade
 *   node sync-hinode.js --dry-run      # mostra o que mudaria, não grava
 *   node sync-hinode.js --max=12       # nº de produtos por categoria
 *
 * SEGURANÇA:
 *   - Se vier menos que MIN_PRODUCTS no total, ABORTA com erro
 *     (exit 1) e NÃO grava nada — nunca apaga/zera o catálogo.
 *   - Se o índice não tiver os marcadores esperados, ABORTA.
 *   - rating/reviews são determinísticos (derivados do id do produto),
 *     pois a API da Hinode não expõe avaliações — assim o catálogo
 *     não "muda" sozinho a cada execução sem motivo.
 *
 * REQUER: Node.js 18+ (fetch nativo).
 */

const fs = require('fs');
const path = require('path');

// =====================================================================
// CONFIG
// =====================================================================
const INDEX_PATH   = path.join(__dirname, 'index.html');
const DRY_RUN      = process.argv.includes('--dry-run');
const MAX_ARG      = process.argv.find(a => a.startsWith('--max='));
const MAX_PER_CAT  = MAX_ARG ? Math.max(1, parseInt(MAX_ARG.split('=')[1]) || 8) : 8;
const MIN_PRODUCTS = 12; // trava de segurança: abaixo disso, aborta sem gravar

const API = 'https://www.hinode.com.br/api/catalog_system/pub/products/search';
const UA  = { headers: { 'User-Agent': 'Mozilla/5.0 (HinodeExpressSync/1.0)', 'Accept': 'application/json' } };

const MARK_START = '// <PRODUCTS-AUTO:START> (gerado por sync-hinode.js — nao editar a mao)';
const MARK_END   = '// <PRODUCTS-AUTO:END>';

// Mapa: categoria da UI -> caminho de categoria na VTEX + cor de fundo.
// Ordem importa: a mais específica (Skincare) vem antes da ampla (Corpo)
// para a deduplicação classificar certo.
const CATEGORIES_TO_SYNC = [
  { cat: 'Masculino', vtexPath: 'fragrancias/fragrancias-masculinas', bg: 'bg-4', emoji: '🌿' },
  { cat: 'Perfumes',  vtexPath: 'fragrancias/fragrancias-femininas',  bg: 'bg-2', emoji: '🌹' },
  { cat: 'Maquiagem', vtexPath: 'maquiagem',                          bg: 'bg-6', emoji: '💋' },
  { cat: 'Skincare',  vtexPath: 'corpo-e-banho/rosto',                bg: 'bg-3', emoji: '🌟' },
  { cat: 'Cabelos',   vtexPath: 'cabelos',                            bg: 'bg-5', emoji: '💆' },
  { cat: 'Corpo',     vtexPath: 'corpo-e-banho',                      bg: 'bg-1', emoji: '🪻' },
];

const EMOJI_BY_KW = [
  [/parfum|colônia|colonia|fragran|deo\b/i, '🌹'],
  [/batom|gloss|labial/i, '💋'],
  [/base|corretivo|pó\b|po compacto/i, '🌟'],
  [/sérum|serum/i, '✨'],
  [/hidratante|creme/i, '💧'],
  [/máscara|mascara/i, '💆'],
  [/shampoo|condicionador/i, '🧴'],
  [/protetor solar|fps/i, '☀️'],
  [/óleo|oleo/i, '💧'],
  [/lápis|lapis|delineador/i, '🖤'],
  [/kit|combo|presente/i, '🎁'],
];

// =====================================================================
// UTIL
// =====================================================================
function detectEmoji(name, fallback) {
  for (const [re, e] of EMOJI_BY_KW) if (re.test(name)) return e;
  return fallback || '🌷';
}

// hash determinístico (FNV-1a) -> rating/reviews estáveis por produto
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function stableRating(seed) { return parseFloat((4.5 + (hashStr(String(seed)) % 6) / 10).toFixed(1)); } // 4.5–5.0
function stableReviews(seed) { return 80 + (hashStr('r' + seed) % 2500); }

function cleanText(s, max) {
  if (!s) return '';
  const t = String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trim() + '…' : t;
}

// =====================================================================
// API VTEX
// =====================================================================
async function fetchCategory(vtexPath, max) {
  const to = Math.min(49, max * 2 + 4); // pede extra p/ compensar indisponíveis
  const url = `${API}/${vtexPath}?_from=0&_to=${to}`;
  console.log(`  📥 GET /${vtexPath}  (até ${to + 1})`);
  const res = await fetch(url, UA);
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`HTTP ${res.status} em /${vtexPath}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`Resposta não-array em /${vtexPath}`);
  return json;
}

function mapProduct(p, catCfg, id) {
  const it  = p.items && p.items[0];
  const sel = it && it.sellers && it.sellers[0];
  const off = sel && sel.commertialOffer;
  if (!off || !off.IsAvailable || !(off.Price > 0)) return null;

  const price    = Number(off.Price);
  const listP    = Number(off.ListPrice);
  const oldPrice = listP > price ? listP : null;
  const name     = cleanText(p.productName, 40);
  if (!name) return null;

  const brand = p.brand || 'Hinode';
  let tag = null;
  if (oldPrice) tag = `-${Math.round((oldPrice - price) / oldPrice * 100)}%`;

  return {
    id: `p${id}`,
    name,
    desc: `${brand} • ${catCfg.cat}`,
    cat: catCfg.cat,
    emoji: detectEmoji(p.productName, catCfg.emoji),
    bg: catCfg.bg,
    price,
    oldPrice,
    tag,
    rating: stableRating(p.productId),
    reviews: stableReviews(p.productId),
    description: cleanText(p.metaTagDescription, 180) ||
      `${name} — produto oficial Hinode (${brand}).`,
  };
}

// =====================================================================
// GERAR BLOCO
// =====================================================================
function generateBlock(products) {
  const L = [];
  L.push(MARK_START);
  L.push('// ========================================');
  L.push('// CATÁLOGO REAL HINODE — gerado automaticamente');
  L.push(`// Última sincronização: ${new Date().toISOString()}`);
  L.push('// Fonte: hinode.com.br — API pública de catálogo (VTEX)');
  L.push(`// Total: ${products.length} produtos`);
  L.push('// ========================================');
  L.push('const PRODUCTS = [');
  const cats = [...new Set(products.map(p => p.cat))];
  for (const c of cats) {
    L.push(`  // ===== ${c} =====`);
    for (const p of products.filter(x => x.cat === c)) {
      const parts = [
        `id: ${JSON.stringify(p.id)}`,
        `name: ${JSON.stringify(p.name)}`,
        `desc: ${JSON.stringify(p.desc)}`,
        `cat: ${JSON.stringify(p.cat)}`,
        `emoji: ${JSON.stringify(p.emoji)}`,
        `bg: ${JSON.stringify(p.bg)}`,
        `price: ${p.price}`,
        `oldPrice: ${p.oldPrice != null ? p.oldPrice : 'null'}`,
        `tag: ${p.tag != null ? JSON.stringify(p.tag) : 'null'}`,
        `rating: ${p.rating}`,
        `reviews: ${p.reviews}`,
        `description: ${JSON.stringify(p.description)}`,
      ];
      L.push('  { ' + parts.join(', ') + ' },');
    }
  }
  L.push('];');
  L.push(MARK_END);
  return L.join('\n');
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  console.log('🌹 HINODE EXPRESS — SYNC (API VTEX)');
  console.log('═'.repeat(52));
  console.log(`📁 Index: ${INDEX_PATH}`);
  console.log(`🔢 Máx por categoria: ${MAX_PER_CAT}`);
  console.log(`💧 Dry run: ${DRY_RUN ? 'SIM' : 'NÃO'}`);
  console.log('═'.repeat(52));

  if (!fs.existsSync(INDEX_PATH)) {
    console.error('❌ index.html não encontrado.');
    process.exit(1);
  }
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  if (!html.includes(MARK_START) || !html.includes(MARK_END)) {
    console.error('❌ Marcadores <PRODUCTS-AUTO:START/END> não encontrados no index.html.');
    console.error('   (Não vou gravar para não corromper o arquivo.)');
    process.exit(1);
  }

  const started = Date.now();
  const all = [];
  const seen = new Set();
  const counter = { v: 1 };

  for (const cfg of CATEGORIES_TO_SYNC) {
    console.log(`\n📂 ${cfg.cat}`);
    let raw;
    try {
      raw = await fetchCategory(cfg.vtexPath, MAX_PER_CAT);
    } catch (e) {
      console.log(`  ⚠️  ${e.message} — pulando categoria`);
      continue;
    }
    let added = 0;
    for (const p of raw) {
      if (added >= MAX_PER_CAT) break;
      if (seen.has(p.productId)) continue;
      const mapped = mapProduct(p, cfg, counter.v);
      if (!mapped) continue;
      seen.add(p.productId);
      all.push(mapped);
      counter.v++;
      added++;
    }
    console.log(`  ✓ ${added} produtos`);
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`✅ Total coletado: ${all.length} produtos em ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const byCat = {};
  all.forEach(p => byCat[p.cat] = (byCat[p.cat] || 0) + 1);
  Object.entries(byCat).forEach(([c, n]) => console.log(`   ${c}: ${n}`));
  console.log(`🔥 Em promoção: ${all.filter(p => p.oldPrice).length}`);

  // ---- TRAVA DE SEGURANÇA ----
  if (all.length < MIN_PRODUCTS) {
    console.error(`\n❌ ABORTADO: só ${all.length} produtos (mínimo ${MIN_PRODUCTS}).`);
    console.error('   Não vou regravar o index.html para não destruir o catálogo.');
    process.exit(1);
  }

  const block = generateBlock(all);
  const re = /\/\/ <PRODUCTS-AUTO:START>[\s\S]*?\/\/ <PRODUCTS-AUTO:END>/;
  if (!re.test(html)) {
    console.error('\n❌ ABORTADO: não localizei o bloco entre os marcadores.');
    process.exit(1);
  }
  const newHTML = html.replace(re, block);

  // sanidade pós-substituição
  if (!newHTML.includes('const PRODUCTS = [') ||
      !newHTML.includes('const CATEGORIES = [') ||
      !newHTML.includes(MARK_END)) {
    console.error('\n❌ ABORTADO: resultado inconsistente, nada foi gravado.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: primeiras 16 linhas do novo bloco ---');
    console.log(block.split('\n').slice(0, 16).join('\n'));
    console.log('--- (nada foi gravado) ---');
    return;
  }

  fs.writeFileSync(INDEX_PATH + '.backup', html);
  fs.writeFileSync(INDEX_PATH, newHTML);
  console.log(`\n✅ index.html atualizado (backup em index.html.backup)`);
  console.log('🎉 Sincronização concluída!');
}

main().catch(e => { console.error('\n❌ Erro fatal:', e); process.exit(1); });
