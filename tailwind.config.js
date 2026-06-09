/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}', './public/**/*.html'],
  theme: {
    extend: {
      colors: {
        'globant-green':   'var(--globant-green)',
        'globant-dark':    'var(--globant-dark)',
        'globant-darker':  'var(--globant-darker)',
        'globant-card':    'var(--globant-card)',
        'globant-border':  'var(--globant-border)',
        'globant-text':    'var(--globant-text)',
        'globant-muted':   'var(--globant-muted)',
        'globant-accent':  'var(--globant-accent)',
        'globant-success': 'var(--globant-success)',
        'globant-warning': 'var(--globant-warning)',
        'globant-danger':  'var(--globant-danger)',
        'globant-info':    'var(--globant-info)',
      },
    },
  },
  plugins: [],
};
