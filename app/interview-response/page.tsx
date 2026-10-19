import type { Metadata } from "next";
import InterviewResponse from "@/components/recruitment/InterviewResponse";

export const metadata: Metadata = {
  title: "面试邀请答复 · 拾才",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InterviewResponsePage() {
  return <InterviewResponse />;
}
