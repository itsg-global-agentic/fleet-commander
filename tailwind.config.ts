import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['src/client/**/*.{tsx,ts}'],
  theme: {
    extend: {
      colors: {
        dark: {
          base: '#0D1117',
          surface: '#161B22',
          border: '#30363D',
          text: '#E6EDF3',
          muted: '#8B949E',
          accent: '#58A6FF',
        },
      },
    },
  },
  plugins: [],
};

export default config;
