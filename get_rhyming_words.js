import { chromium } from 'playwright';

const BASE = 'https://buscapalabras.com.ar/rimas.php';

function uniq(arr) {
  return [...new Set(arr)];
}

// Extrae todas las palabras visibles que terminen en el sufijo
async function extractByRegex(page, suffix) {
  const html = await page.content();
  // Quita etiquetas y deja texto plano:
  const text = (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  // Palabras con letras españolas y apóstrofo opcional
  const re = new RegExp(`\\b[a-záéíóúüñ]+${suffix.toLowerCase()}\\b`, 'gi');
  const matches = text.match(re) || [];
  // Filtra duplicados y cosas raras (muy cortas, números, etc.)
  return uniq(matches.filter(w => w.length >= suffix.length + 1));
}

async function getRhymingWords(suffix) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 1) Intenta localizar el input por placeholder (lo que se ve en la página)
    const input = page.locator('#palabra');
    const hasInput = await input.count().then(n => n > 0).catch(() => false);

    if (hasInput) {
      await input.fill(suffix, { timeout: 10000 });

      // 2) Click en “Buscar rimas” si existe; si no, Enter
      const btn = page.getByRole('button', { name: /buscar/i });
      if (await btn.count()) {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 30000 }),
          btn.click(),
        ]);
      } else {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 30000 }),
          page.keyboard.press('Enter'),
        ]);
      }
    } else {
      // Fallback: intenta con querystring (algunos sitios lo aceptan)
      await page.goto(`${BASE}?texto=${encodeURIComponent(suffix)}`, {
        waitUntil: 'networkidle',
        timeout: 45000,
      });
    }

    // Espera a que aparezca algo de resultados (si existe algún contenedor típico)
    // No falles si no aparece; el extractor por regex igual se ejecuta.
    await page.waitForTimeout(800); // micro-pausa para asentar el DOM

    // 3) Extrae por regex de todo el texto visible (más resistente a cambios de DOM)
    const words = await extractByRegex(page, suffix);

    return words;
  } finally {
    await ctx.close();
    await browser.close();
  }
}

(async () => {
  const suffix = (process.argv[2] || '').trim();
  if (!suffix) {
    console.error('Uso: node get_rhyming_words.js <sufijo>   Ej: node get_rhyming_words.js impa');
    process.exit(1);
  }

  try {
    const words = await getRhymingWords(suffix);
    if (!words.length) {
      console.log('No encontré coincidencias (o el sitio cambió el marcado / bloquea automatización).');
      process.exit(2);
    }
    console.log(words.join(', '));
  } catch (err) {
    console.error('Fallo al extraer:', err.message);
    process.exit(3);
  }
})();
