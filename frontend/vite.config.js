import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// أثناء التطوير: أي طلب يبدأ بـ /api يُحوَّل إلى خادم Express (فلا نحتاج CORS)
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:5000" },
  },
});
