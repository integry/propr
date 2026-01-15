/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          '500': '#24A3A3',
          '600': '#1D8A8A',
          '700': '#167575',
        },
        light: {
          '100': '#F8F9FA',
          '200': '#EDF2F7',
        }
      }
    },
  },
  plugins: [],
}