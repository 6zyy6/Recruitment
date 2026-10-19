import type { Metadata } from "next";
import CandidateReview from "@/components/recruitment/CandidateReview";

export const metadata: Metadata = {
  title: "确认招聘资料 · 拾才",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function CandidateReviewPage() {
  return <CandidateReview />;
}
