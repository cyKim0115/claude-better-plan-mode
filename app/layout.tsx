import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Better Plan Mode",
  description: "상호작용 가능한 웹 플랜 모드 — 코멘트로 수정하고 부분 착수까지",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="topbar">
          <a href="/" className="brand">◆ Better Plan Mode</a>
          <span className="brand-sub">plan → comment → revise → execute</span>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
