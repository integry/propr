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
          '500': '#E63946',
          '600': '#C53030',
        },
        light: {
          '100': '#FF0000',
          '200': '#EDF2F7',
        }
      }
    },
  },
  plugins: [],
}