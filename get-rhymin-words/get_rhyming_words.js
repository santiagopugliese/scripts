// get_rhyming_words.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUSCA_URL = "https://buscapalabras.com.ar/rimas.php";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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

function rankTop(words, freqMap, limit) {
  if (!words.length) return [];
  const uniq = Array.from(new Set(words));
  if (!freqMap || freqMap.size === 0) {
    return uniq.sort((a, b) => a.localeCompare(b, "es")).slice(0, limit);
  }
  const scored = uniq.map((w) => [w, freqMap.get(w) ?? 0]);
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
  return scored.slice(0, limit).map(([w]) => w);
}

function carrierTermsFor(suffix) {
  if (suffix.length === 2) return [`d${suffix}`, suffix];
  return [suffix];
}

function fold(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

async function extractListsScopedToHeadings(page, carrier) {
  const targetPieces = [
    "palabras que riman consonante con ",
    fold(carrier),
    " de "
  ];

  return await page.evaluate(
    ({ targetPieces }) => {
      const fold = (s) =>
        (s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();

      const root = document.querySelector(".fz1") || document.body;
      const hits = [];

      const h3s = Array.from(root.querySelectorAll("h3"));
      for (const h3 of h3s) {
        const t = fold(h3.textContent || "");
        const match =
          t.includes(targetPieces[0]) &&
          t.includes(targetPieces[1]) &&
          t.includes(targetPieces[2]);

        if (!match) continue;

        let p = h3.nextElementSibling;
        while (p && p.tagName.toLowerCase() === "p") {
          const txt = p.textContent || "";

          const looksLikeList =
            txt.includes(",") ||
            /\b\w+[ \t]+\w+/.test(txt) ||
            /[a-záéíóúüñ]{2,}/i.test(txt);
          if (looksLikeList) {
            hits.push(txt);
            break;
          }
          p = p.nextElementSibling;
        }
      }

      const allText = hits.join(" ");
      const tokens = allText
        .split(/[\s,;·—–-]+/g)
        .map((w) =>
          (w || "")
            .toLowerCase()
            .normalize("NFC")
            .replace(/^[^a-záéíóúüñ]+|[^a-záéíóúüñ]+$/gi, "")
        )
        .filter(Boolean);

      return tokens;
    },
    { targetPieces }
  );
}

async function scrapeOneSuffix(page, suffix, { debugDir = null } = {}) {
  const carriers = carrierTermsFor(suffix);
  for (const carrier of carriers) {
    await page.goto(BUSCA_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("#palabra", { timeout: 15000 });
    await page.fill("#palabra", carrier);

    const btn = await page.$('input[type="submit"].botFoBu');
    if (btn) {
      await btn.click();
    } else {
      await page.press("#palabra", "Enter");
    }

    await page.waitForTimeout(800);

    if (debugDir) {
      fs.mkdirSync(debugDir, { recursive: true });
      const safe = `q_${carrier}`.replace(/[^a-záéíóúüñ0-9]+/gi, "_");
      await page.screenshot({ path: path.join(debugDir, `shot_${safe}.png`), fullPage: true });
      const html = await page.content();
      fs.writeFileSync(path.join(debugDir, `page_${safe}.html`), html, "utf8");
    }

    const tokens = await extractListsScopedToHeadings(page, carrier);
    const matches = tokens.filter((t) => t.endsWith(suffix));

    if (matches.length) return Array.from(new Set(matches));
  }
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const suffixes = args.filter((a) => !a.startsWith("--")).map(normalize).filter(Boolean).slice(0, 5);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const corpusArg = args.find((a) => a.startsWith("--corpus="));
  const debug = args.includes("--debug");

  if (suffixes.length === 0) {
    console.error("Uso: node get_rhyming_words.js <sufijo1> [sufijo2 … sufijo5] [--limit=N] [--corpus=ruta.txt] [--debug]");
    process.exit(1);
  }

  const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1])) : 20;
  const corpusPath = corpusArg ? corpusArg.split("=")[1] : path.join(__dirname, "es_50k.txt");
  const freqMap = loadCorpus(corpusPath);
  const debugDir = debug ? path.join(__dirname, "debug_snapshots") : null;

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  try {
    const perSuffixTop = [];
    for (const suf of suffixes) {
      const words = await scrapeOneSuffix(page, suf, { debugDir });
      const top = rankTop(words, freqMap, limit);
      perSuffixTop.push(top);
      await sleep(600 + Math.floor(Math.random() * 400));
    }

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
