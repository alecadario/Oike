const esbuild = require('esbuild');
const path = require('path');

esbuild.build({
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
}).then(() => {
  console.log('✅ Built src/app.jsx → public/app.js');
}).catch(() => process.exit(1));
