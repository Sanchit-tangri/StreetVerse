/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class', '[data-theme="eye-comfort-dark"]'],
  content: [
    './apps/buyer-web/**/*.{js,ts,jsx,tsx}',
    './apps/seller-web/**/*.{js,ts,jsx,tsx}',
    './packages/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        cream: {
          50: '#FDFBF7',
          100: '#FAF7F2',
          200: '#F3ECE2',
          300: '#E7DDD0',
          400: '#D5C4B0',
          500: '#BAA287'
        },
        terracotta: {
          500: '#D97706',
          600: '#B45309',
          700: '#92400E'
        },
        neighborhoodGreen: {
          500: '#10B981',
          600: '#059669',
          700: '#047857'
        }
      },
      borderRadius: {
        'organic': '0.875rem',
        'friendly': '1.25rem'
      }
    }
  },
  plugins: []
};
