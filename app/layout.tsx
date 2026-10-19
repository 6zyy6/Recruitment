import type { Metadata } from "next";
import "./globals.css";
import "./workspace.css";
import "./selection.css";
import "./intake.css";
import "./candidate-review.css";
import "./careers.css";

export const metadata: Metadata = {
  title: "拾才 TalentFlow · 招聘协作工作台",
  description:
    "社招与校招一体的招聘协作演示，管理职位、候选人、面试、录用和入职。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
