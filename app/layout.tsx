import type { Metadata } from "next";
import { Barlow } from "next/font/google";
import "./globals.css";

const barlow = Barlow({
  variable: "--font-sans",
  subsets: ["latin", "vietnamese"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Penguin",
  description: "Multi-agent workspace for delegating complex workflows to a coordinated team of AI agents.",
  manifest: "/manifest.json",
  themeColor: "#3eaaf5",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Penguin",
  },
  other: {
    google: "notranslate",
  },
};

import { ToastContainer } from "@/components/toast";
import { AntiSnoop } from "@/components/anti-snoop";

// Sync the saved theme to <html> BEFORE React hydrates, so the first paint
// matches the user's last choice (otherwise dark→light toggle flashes on every
// reload). Defaults to "dark" when nothing saved. The /login screen is ALWAYS
// dark regardless of the saved preference (it's designed dark-only) — forced
// here so there's no light→dark flash on a direct page load.
const themeBootstrap = `
try {
  var path = location.pathname || '';
  if (path === '/login' || path.indexOf('/login') === 0) {
    document.documentElement.classList.add('dark');
  } else {
    var t = localStorage.getItem('agentp.theme') || 'dark';
    document.documentElement.classList.add(t === 'light' ? 'light' : 'dark');
  }
} catch (e) {
  document.documentElement.classList.add('dark');
}
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="vi"
      translate="no"
      className={`${barlow.variable} notranslate h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        {/* Lordicon — animated SVG/Lottie icons. Defer so it doesn't block
            first paint; once loaded, defines the <lord-icon> custom element
            used by components/lord-icon.tsx. CDN-cached after first hit. */}
        <script src="https://cdn.lordicon.com/lordicon.js" defer />
      </head>
      <body className="min-h-full flex flex-col bg-[#262624] text-slate-100">
        <AntiSnoop />
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
