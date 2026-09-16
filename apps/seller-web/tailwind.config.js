/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        warmCream: '#FAF7F2',
        warmSurface: '#FFFDF9',
        warmBorder: '#E7E5E4',
      },
    },
  },
  plugins: [],
};
