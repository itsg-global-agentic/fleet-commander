import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

process.chdir(root);

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

console.log('\n  Fleet Commander → http://localhost:4680\n');

// Open browser after 2s delay
setTimeout(() => {
  const cmd = process.platform === 'win32' ? 'start' :
              process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    execSync(`${cmd} http://localhost:4680`, { stdio: 'ignore', shell: true });
  } catch { /* ignore */ }
}, 2000);

// Start server
const server = spawn('node', ['dist/server/index.js'], {
  stdio: 'inherit',
  cwd: root
});

server.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  server.kill('SIGINT');
});
