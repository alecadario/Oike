const { execSync } = require('child_process');
const esbuild = require('esbuild');
const path = require('path');

async function build() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/app.jsx')],
    bundle: true,
    outfile: path.join(__dirname, '../public/app.js'),
    format: 'iife',
    target: ['chrome80'],
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    loader: { '.js': 'jsx' },
    minify: true,
    logLevel: 'info',
  });

  execSync('npx tailwindcss -i ./src/styles/app.css -o ./public/app.css --minify', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });

  console.log('✅ Built src/app.jsx → public/app.js + public/app.css');
}

build().catch(() => process.exit(1));
