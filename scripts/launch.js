import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

process.chdir(root);

const port = process.env.PORT || '4680';

// Auto-install if needed
if (!existsSync('node_modules')) {
  console.log('Installing dependencies...');
  execSync('npm install', { stdio: 'inherit' });
}

// Auto-build if needed
if (!existsSync('dist/server/index.js')) {
  console.log('Building Fleet Commander...');
  execSync('npm run build', { stdio: 'inherit' });
}

console.log(`\n  Fleet Commander → http://localhost:${port}\n`);

// Start server first, then wait for it to be ready
const server = spawn('node', ['dist/server/index.js'], {
  stdio: 'inherit',
  cwd: root
});

// Poll health endpoint before opening browser
async function waitForServer(url, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

waitForServer(`http://localhost:${port}/api/health`).then((ok) => {
  if (ok) {
    const cmd = process.platform === 'win32' ? 'start' :
                process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      execSync(`${cmd} http://localhost:${port}`, { stdio: 'ignore', shell: true });
    } catch { /* ignore */ }
  }
});

server.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  server.kill('SIGTERM');
});
