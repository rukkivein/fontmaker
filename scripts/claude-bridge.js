'use strict';

/**
 * claude-bridge.js
 * ----------------
 * Bilgisayarınızda KURULU olan Claude Code CLI'ına (`claude` komutu)
 * programatik olarak erişmek için küçük bir köprü.
 *
 * Bu dosya Anthropic API'sine doğrudan bağlanmaz — sizin makinenizde
 * zaten kurulu ve oturum açılmış olan `claude` komutunu başlatır,
 * non-interaktif modda (`claude -p`) çağırır ve cevabı geri verir.
 *
 * İki şekilde kullanılır:
 *
 *   1) Kütüphane olarak (başka JS dosyalarından):
 *        const { ask, askStream, isInstalled } = require('./scripts/claude-bridge');
 *        const cevap = await ask('Bana bir font ismi öner');
 *        console.log(cevap);
 *
 *   2) Komut satırından:
 *        node scripts/claude-bridge.js "Merhaba, kimsin?"
 *        node scripts/claude-bridge.js --json "2+2 kaç?"
 *        node scripts/claude-bridge.js --stream "Uzun bir hikaye yaz"
 *        echo "Bu metni özetle" | node scripts/claude-bridge.js
 *        node scripts/claude-bridge.js --check        # kurulu mu?
 */

const { spawn } = require('child_process');

/**
 * Sistemde `claude` komutunun adı. CLAUDE_BIN ortam değişkeniyle
 * (örn. tam yol vererek) ezilebilir.
 */
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Düşük seviyeli çalıştırıcı. `claude` komutunu verilen argümanlarla
 * başlatır, stdin'e prompt'u yazar, stdout/stderr'i toplar.
 *
 * @param {string[]} args   - claude'a geçilecek argümanlar
 * @param {object}   opts
 * @param {string}  [opts.input]       - stdin'e yazılacak metin (prompt)
 * @param {string}  [opts.cwd]         - çalışma dizini
 * @param {number}  [opts.timeoutMs]   - zaman aşımı (ms), varsayılan 120000
 * @param {function}[opts.onData]      - canlı (stream) çıktı için callback
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 */
function run(args, opts = {}) {
  const { input, cwd, timeoutMs = 120000, onData } = opts;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        // shell:false — argümanlar doğrudan geçer, enjeksiyon riski yok.
      });
    } catch (err) {
      return reject(wrapSpawnError(err));
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          // Nazikçe ölmezse zorla:
          setTimeout(() => child.kill('SIGKILL'), 2000).unref();
        }, timeoutMs)
      : null;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(wrapSpawnError(err));
    });

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (onData) onData(s);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`claude komutu ${timeoutMs} ms içinde yanıt vermedi (zaman aşımı).`));
      }
      resolve({ stdout, stderr, code: code == null ? -1 : code });
    });

    // Prompt'u stdin üzerinden veriyoruz (çok uzun metinler ve özel
    // karakterler için argümandan daha güvenli).
    if (input != null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function wrapSpawnError(err) {
  if (err && err.code === 'ENOENT') {
    return new Error(
      `'${CLAUDE_BIN}' komutu bulunamadı. Claude Code CLI kurulu mu? ` +
        `Kontrol: terminalde 'claude --version' çalıştırın. ` +
        `Farklı bir yol için CLAUDE_BIN ortam değişkenini ayarlayın.`
    );
  }
  return err;
}

/**
 * Claude Code CLI'ı kurulu mu / çalışıyor mu?
 * @returns {Promise<string|false>}  Kuruluysa sürüm metnini, değilse false döner.
 */
async function isInstalled() {
  try {
    const { stdout, code } = await run(['--version'], { timeoutMs: 15000 });
    return code === 0 ? stdout.trim() : false;
  } catch {
    return false;
  }
}

/**
 * Claude'a bir prompt gönderir, tek seferde tam yanıtı (düz metin) döner.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.model]         - örn. 'claude-opus-4-8' (--model)
 * @param {string[]} [opts.extraArgs]   - claude'a ek argümanlar
 * @returns {Promise<string>}
 */
async function ask(prompt, opts = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('ask(): prompt boş olamaz.');
  }
  const args = ['-p'];
  if (opts.model) args.push('--model', opts.model);
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);

  const { stdout, stderr, code } = await run(args, {
    input: String(prompt),
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });

  if (code !== 0) {
    throw new Error(
      `claude sıfırdan farklı çıkış kodu döndürdü (${code}).\n` +
        (stderr.trim() || stdout.trim() || '(çıktı yok)')
    );
  }
  return stdout.trim();
}

/**
 * ask() gibi, ama yanıt parçaları geldikçe onData(parça) çağrılır.
 * Tamamlandığında biriken tüm metni döner.
 *
 * @param {string} prompt
 * @param {(chunk:string)=>void} onData
 * @param {object} [opts]  - ask() ile aynı seçenekler
 * @returns {Promise<string>}
 */
async function askStream(prompt, onData, opts = {}) {
  if (typeof onData !== 'function') {
    throw new Error('askStream(): ikinci argüman bir fonksiyon olmalı.');
  }
  const args = ['-p'];
  if (opts.model) args.push('--model', opts.model);
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);

  const { stdout, stderr, code } = await run(args, {
    input: String(prompt),
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    onData,
  });

  if (code !== 0) {
    throw new Error(
      `claude sıfırdan farklı çıkış kodu döndürdü (${code}).\n` +
        (stderr.trim() || '(stderr yok)')
    );
  }
  return stdout.trim();
}

/**
 * ask() ile aynı, ama JSON çıktı modunu (--output-format json) kullanır
 * ve ayrıştırılmış nesneyi döner (içinde yanıt + üst veri bulunur).
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
async function askJson(prompt, opts = {}) {
  const raw = await ask(prompt, {
    ...opts,
    extraArgs: ['--output-format', 'json', ...(opts.extraArgs || [])],
  });
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('claude JSON yanıtı ayrıştırılamadı:\n' + raw);
  }
}

module.exports = { ask, askStream, askJson, isInstalled, run, CLAUDE_BIN };

/* --------------------------------------------------------------------- */
/* Komut satırından doğrudan çalıştırma                                   */
/* --------------------------------------------------------------------- */

if (require.main === module) {
  main().catch((err) => {
    console.error('Hata:', err.message);
    process.exit(1);
  });
}

async function main() {
  const argv = process.argv.slice(2);

  // Bayrakları ayıkla
  let mode = 'text'; // text | json | stream
  let model;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') {
      const v = await isInstalled();
      if (v) {
        console.log('✓ Claude Code kurulu:', v);
        process.exit(0);
      } else {
        console.error('✗ Claude Code bulunamadı. Terminalde "claude --version" deneyin.');
        process.exit(1);
      }
    } else if (a === '--json') {
      mode = 'json';
    } else if (a === '--stream') {
      mode = 'stream';
    } else if (a === '--model') {
      model = argv[++i];
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      rest.push(a);
    }
  }

  // Prompt: argümanlardan ya da stdin'den (boru ile)
  let prompt = rest.join(' ').trim();
  if (!prompt && !process.stdin.isTTY) {
    prompt = (await readStdin()).trim();
  }
  if (!prompt) {
    printHelp();
    process.exit(1);
  }

  if (mode === 'json') {
    const obj = await askJson(prompt, { model });
    console.log(JSON.stringify(obj, null, 2));
  } else if (mode === 'stream') {
    await askStream(prompt, (chunk) => process.stdout.write(chunk), { model });
    process.stdout.write('\n');
  } else {
    const out = await ask(prompt, { model });
    console.log(out);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

function printHelp() {
  console.log(`
claude-bridge — bilgisayarınızda kurulu Claude Code CLI'ına köprü

Kullanım:
  node scripts/claude-bridge.js [seçenekler] "prompt"
  echo "prompt" | node scripts/claude-bridge.js [seçenekler]

Seçenekler:
  --check            Claude Code kurulu mu diye kontrol et ve çık
  --json             Yanıtı JSON formatında al
  --stream           Yanıtı parça parça (canlı) yazdır
  --model <ad>       Belirli bir model kullan (örn. claude-opus-4-8)
  -h, --help         Bu yardımı göster

Ortam değişkenleri:
  CLAUDE_BIN         'claude' yerine kullanılacak komut/tam yol

Örnekler:
  node scripts/claude-bridge.js "Bir font ismi öner"
  node scripts/claude-bridge.js --json "2+2 kaç?"
  node scripts/claude-bridge.js --stream "Kısa bir şiir yaz"
`);
}
