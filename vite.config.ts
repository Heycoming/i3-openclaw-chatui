import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "/chatui/",
  server: {
    port: 8083,
    allowedHosts: [".nip.io", "localhost", "127.0.0.1"],
  },
});
