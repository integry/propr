/** @type {import('tailwindcss').Config} */
export default {
  content: {
    relative: true,
    files: [
      "./index.html",
      "./src/**/*.{js,ts,jsx,tsx}",
    ],
  },
  theme: {
    extend: {
      // Keep `font-sans` identical to the body font so explicit resets never fall
      // back to a different stack than the rest of the UI.
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      colors: {
        primary: {
          '500': '#24A3A3',
          '600': '#1D8A8A',
          '700': '#167575',
        },
        light: {
          '100': '#F8F9FA',
          '200': '#EDF2F7',
        },
        // Dashboard card styling
        'card-bg': '#FFFFFF',
        'card-border': '#E2E8F0',
      }
    },
  },
  plugins: [],
}
