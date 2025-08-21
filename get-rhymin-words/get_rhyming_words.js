import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUSCA_URL = "https://buscapalabras.com.ar/rimas.php";

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function loadCorpus(corpusPath) {
  const freqMap = new Map();
  if (!corpusPath || !fs.existsSync(corpusPath)) return freqMap;
  const txt = fs.readFileSync(corpusPath, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const [w, f] = line.trim().split(/\s+/);
    if (!w || !f) continue;
    freqMap.set(w.toLowerCase(), Number(f) || 0);
  }
  return freqMap;
}

function normalize(w) {
  return (w || "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/^[^a-záéíóúüñ]+|[^a-záéíóúüñ]+$/gi, "");
}

function endsWithQuery(word, query) {
  return word.endsWith(query);
}

function rankTop(words, freqMap, limit) {
  if (!words.length) return [];
  if (!freqMap || freqMap.size === 0) {
    return Array.from(new Set(words)).sort((a, b) => a.localeCompare(b, "es")).slice(0, limit);
  }
  const scored = Array.from(new Set(words)).map(w => [w, freqMap.get(w) ?? 0]);
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
  return scored.slice(0, limit).map(([w]) => w);
}

async function scrapeOneSuffix(page, suffix) {
  await page.goto(BUSCA_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#palabra", { timeout: 15000 });
  await page.fill("#palabra", suffix);
  const btn = await page.$('input[type="submit"].botFoBu');
  if (btn) {
    await Promise.all([page.waitForLoadState("domcontentloaded"), btn.click()]);
  } else {
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.press("#palabra", "Enter")]);
  }

  const rawTexts = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("a, b, strong, li, p, span, div"));
    return nodes.map(n => n.textContent || "");
  });

  const tokens = rawTexts.join(" ").split(/[\s,;·—–-]+/g).map(normalize).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (t.length >= suffix.length && endsWithQuery(t, suffix)) out.push(t);
  }
  // quitar la propia terminación exacta si viniera como “palabra”
  return Array.from(new Set(out)).filter(w => w !== suffix);
}

async function main() {
  // CLI: node get_rhyming_words_multi.js impa ique … --limit 20 --corpus es_50k.txt
  const args = process.argv.slice(2);
  const suffixes = args.filter(a => !a.startsWith("--")).map(normalize).filter(Boolean).slice(0, 5);
  const limitArg = args.find(a => a.startsWith("--limit=")) || null;
  const corpusArg = args.find(a => a.startsWith("--corpus=")) || null;

  if (suffixes.length === 0) {
    console.error("Uso: node get_rhyming_words_multi.js <sufijo1> [sufijo2 … sufijo5] [--limit=N] [--corpus=ruta.txt]");
    process.exit(1);
  }

  const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1])) : 20;
  const corpusPath = corpusArg ? corpusArg.split("=")[1] : path.join(__dirname, "es_50k.txt");
  const freqMap = loadCorpus(corpusPath);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  });

  try {
    const perSuffixTop = [];
    for (const suf of suffixes) {
      const words = await scrapeOneSuffix(page, suf);
      const top = rankTop(words, freqMap, limit);
      perSuffixTop.push(top);
      // pequeño delay entre búsquedas para ser amable con el sitio
      await sleep(800);
    }

    // Unir todas las listas en el orden de los sufijos, quitando duplicados
    const union = [];
    const seen = new Set();
    for (const list of perSuffixTop) {
      for (const w of list) {
        if (!seen.has(w)) {
          seen.add(w);
          union.push(w);
        }
      }
    }

    console.log(union.join(", "));
  } catch (e) {
    console.error("Falló la extracción/union:", e?.message || e);
    process.exit(2);
  } finally {
    await browser.close();
  }
}

main();
