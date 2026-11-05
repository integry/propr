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
      },
      // Mobile bottom sheets rise from the screen's edge over a fading scrim.
      keyframes: {
        'sheet-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        'sheet-up': 'sheet-up 200ms ease-out',
        'fade-in': 'fade-in 200ms ease-out',
      },
    },
  },
  plugins: [
    // Layouts for a finger rather than a mouse: a coarse primary pointer, or
    // any phone-width viewport. `touch:` rows get 44px targets and no
    // hover-only controls; fine-pointer desktop rows stay compact. This is a
    // variant, not a `screens` entry: a raw screen disables every `max-*` and
    // `min-*` variant (such as `max-lg:min-h-11`) across the app.
    ({ addVariant }) => {
      addVariant('touch', '@media (pointer: coarse), (max-width: 639.98px)');
    },
  ],
}
