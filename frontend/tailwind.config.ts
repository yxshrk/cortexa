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
          50:  "#f7f7f8",
          100: "#f0f0f1",
          200: "#e5e5e7",
          300: "#d6d6da",
          400: "#8b8b93",
          600: "#5f6067",
          900: "#1f2024",
        },
        panel: "#ffffff",
        copper: "#8a6a4a",
        cyan: "#5f6067",
        accent: {
          DEFAULT: "#1f2024",
          hover:   "#3a3b40",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
