// Builds the app with this machine's own API ID and hash and deploys it to the
// Cloudflare Worker in wrangler.jsonc (gerbi.org), without touching anything git tracks.
//
//   pnpm deploy:cloudflare               typecheck, build into dist/, stage and deploy
//   pnpm deploy:cloudflare --skip-build  stage the dist/ already built and deploy
//   pnpm deploy:cloudflare --dry-run     everything but the upload (passed on to wrangler)
//
// The API ID and hash come from .env.local, which git ignores and Vite reads over .env:
// the build refuses to start without them, so the repo's own .env values never ship.
// The build goes to dist/ (ignored too) and is never copied into public/, so a commit
// cannot carry it to GitHub and `git pull` stays clean. The site is staged into
// tmp/cloudflare-site as build.js would leave public/: the static files public/ keeps
// (keepAsset.js, its folders) with the new bundle over them, source maps left out.
// Roll back with `pnpm dlx wrangler@4 rollback <version-id>`.

import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const keepAsset = require(path.join(root, 'keepAsset.js'));
const publicPath = path.join(root, 'public');
const distPath = path.join(root, 'dist');
const target = path.join(root, 'tmp', 'cloudflare-site');

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const wranglerArgs = args.filter((arg) => arg !== '--skip-build');

// * files the build regenerates that git tracks: put back as they were, so the tree stays the repo's
const GENERATED = ['src/scripts/out/langPack.strings', 'src/lib/settingsSearch/generated.ts'];

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, {cwd: root, stdio: 'inherit', shell: process.platform === 'win32'});
  if(result.status !== 0) {
    console.error(`failed: ${cmd} ${cmdArgs.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

function readEnvLocal() {
  const file = path.join(root, '.env.local');
  const env = {};
  if(fs.existsSync(file)) {
    for(const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if(match) env[match[1]] = match[2];
    }
  }
  return env;
}

const envLocal = readEnvLocal();
if(!/^\d+$/.test(envLocal.VITE_API_ID || '') || !/^[0-9a-f]{32}$/.test(envLocal.VITE_API_HASH || '')) {
  console.error('.env.local needs VITE_API_ID and VITE_API_HASH (from my.telegram.org): refusing to build with the repo\'s own');
  process.exit(1);
}

if(!skipBuild) {
  const dirty = spawnSync('git', ['status', '--porcelain', '--', ...GENERATED], {cwd: root, encoding: 'utf8'}).stdout.trim();
  try {
    run('pnpm', ['run', 'typecheck']);
    run('pnpm', ['exec', 'vite', 'build']);
    run('pnpm', ['run', 'check-bundle']);
  } finally {
    if(!dirty) {
      spawnSync('git', ['checkout', '--', ...GENERATED], {cwd: root, stdio: 'inherit'});
    }
  }
}

if(!fs.existsSync(path.join(distPath, 'index.html'))) {
  console.error('dist/index.html is missing: run without --skip-build');
  process.exit(1);
}

const builtWith = fs.readdirSync(distPath).filter((file) => /^(app|index\.worker)-.*\.js$/.test(file))
.some((file) => fs.readFileSync(path.join(distPath, file), 'utf8').includes(envLocal.VITE_API_HASH));
if(!builtWith) {
  console.error('dist/ was not built with the API hash of .env.local: run without --skip-build');
  process.exit(1);
}

const notMap = (file) => !file.endsWith('.map');

fs.rmSync(target, {recursive: true, force: true});
fs.mkdirSync(target, {recursive: true});
for(const entry of fs.readdirSync(publicPath, {withFileTypes: true})) {
  if(entry.isDirectory() || keepAsset(entry.name)) {
    fs.cpSync(path.join(publicPath, entry.name), path.join(target, entry.name), {recursive: true, filter: notMap});
  }
}
fs.cpSync(distPath, target, {recursive: true, filter: notMap});

run('pnpm', ['dlx', 'wrangler@4', 'deploy', ...wranglerArgs]);
