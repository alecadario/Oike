/**
 * Build script: compiles public/app.jsx → public/app.js
 * Runs during Netlify deploy and locally via `npm run build`
 */

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const SRC  = path.join(__dirname, '../public/app.jsx');
const DEST = path.join(__dirname, '../public/app.js');

function build() {
  console.log('🔨 Building app.jsx → app.js ...');
  const start = Date.now();

  const source = fs.readFileSync(SRC, 'utf8');

  const result = babel.transformSync(source, {
    presets: [
      ['@babel/preset-react', { runtime: 'classic' }]
    ],
    filename: 'app.jsx',
    compact: true,          // minify whitespace
    comments: false,        // strip comments
    sourceMaps: false,
  });

  fs.writeFileSync(DEST, result.code, 'utf8');

  const sizeKb = (fs.statSync(DEST).size / 1024).toFixed(1);
  console.log(`✅ Built in ${Date.now() - start}ms — app.js is ${sizeKb} KB`);
}

build();
