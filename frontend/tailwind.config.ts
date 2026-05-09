import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f6f7f9",
          100: "#eceef2",
          200: "#d3d8e0",
          400: "#7e8597",
          600: "#3f4757",
          900: "#0e1220",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
