import type { Metadata } from "next";
import Careers from "@/components/recruitment/Careers";

export const metadata: Metadata = {
  title: "加入我们 · 拾才 TalentFlow",
  description: "发现适合你的社招与校招职位，在线提交简历。",
  robots: { index: false, follow: false },
};

export default function CareersPage() {
  return <Careers />;
}
